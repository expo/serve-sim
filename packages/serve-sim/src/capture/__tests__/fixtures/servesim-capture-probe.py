"""
Exercises the mitmproxy addon against a real control server and prints one JSON object of results.

The addon holds module-level state (a queue, a reporter thread, a byte counter), so it is loaded once
here and every check reads back through the same instance the proxy would use.
"""

import importlib.util
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

ADDON_PATH = sys.argv[1]

received = []


class ControlHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        received.append(
            {"path": self.path, "body": json.loads(self.rfile.read(length) or b"{}")}
        )
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), ControlHandler)
threading.Thread(target=server.serve_forever, daemon=True).start()

os.environ["SERVE_SIM_CAPTURE_CONTROL_URL"] = f"http://127.0.0.1:{server.server_port}"
os.environ["SERVE_SIM_CAPTURE_CONTROL_TOKEN"] = "probe-token"
os.environ["SERVE_SIM_CAPTURE_FIELDS"] = os.environ.get(
    "PROBE_FIELDS", "header,request-body,response-body"
)
# A proxy nothing is listening on. Any record that arrives proves the addon ignored it; a record that
# honoured it would fail to send and be swallowed.
for name in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
    os.environ[name] = "http://127.0.0.1:1"

spec = importlib.util.spec_from_file_location("servesim_capture", ADDON_PATH)
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)

MAX_BODY_BYTES = addon.MAX_BODY_BYTES


class FakeMessage:
    def __init__(self, content, wire, headers=None, raises=False):
        self.content = content
        self.raw_content = wire
        self.headers = headers if headers is not None else {"Content-Type": "text/plain"}
        self.raises = raises

    def get_content(self, strict=True):
        if self.raises:
            raise ValueError("content-encoding does not match the bytes")
        return self.content


def wait_for(count, timeout=5.0):
    deadline = time.time() + timeout
    while len(received) < count and time.time() < deadline:
        time.sleep(0.02)
    return len(received)


results = {}

# A gzipped body: the wire bytes are what moved, the decoded length is far larger. Reporting the latter
# as `size` overstated throughput by several hundred times.
compressed = addon._part(FakeMessage(b"x" * 10_000, b"gzipbytes" * 10), True)
results["compressedSize"] = compressed["size"]
results["compressedDecodedSize"] = compressed["decodedSize"]

# A body whose content-encoding lies. Strict decoding raises, which would kill the hook and leave the
# row spinning forever.
lying = addon._part(FakeMessage(b"whatever", b"raw-wire-bytes", raises=True), True)
results["lyingSize"] = lying["size"]
results["lyingBody"] = lying["body"]

binary = addon._part(FakeMessage(b"\xff\xfe\x00\x01", b"\xff\xfe\x00\x01"), True)
results["binaryBody"] = binary["body"]
results["binaryBase64"] = binary["base64"]

oversized = addon._part(FakeMessage(b"a" * (MAX_BODY_BYTES + 10), b"a" * (MAX_BODY_BYTES + 10)), True)
results["oversizedTruncated"] = oversized["truncated"]
results["oversizedBodyLength"] = len(oversized["body"])
results["oversizedDecodedSize"] = oversized["decodedSize"]

empty = addon._part(FakeMessage(b"", b""), True)
results["emptySize"] = empty["size"]
results["emptyBody"] = empty["body"]
results["emptyTruncated"] = empty["truncated"]

headers = addon._part(FakeMessage(b"", b"", headers={"Content-Type": "application/json"}), True)
results["headerKeys"] = list(headers["headers"].keys())

# Delivery. Reaching the control server at all proves the hostile proxy above was ignored.
addon.running()
results["readyDelivered"] = wait_for(1) == 1
results["readyPath"] = received[0]["path"] if received else None
results["proxyBypassed"] = bool(received)

received.clear()


class FakeRequest:
    def __init__(self):
        self.method = "GET"
        self.pretty_url = "https://example.test/thing"
        self.pretty_host = "example.test"
        self.port = 443
        self.timestamp_start = 1000.0
        self.content = b""
        self.raw_content = b""
        self.headers = {}

    def get_content(self, strict=True):
        return b""


class FakeFlow:
    def __init__(self, error=None, response=None):
        self.id = "flow-1"
        self.request = FakeRequest()
        self.error = error
        self.response = response


# A response arriving after an error must not produce a second row.
settled = FakeFlow(error="reset", response=object())
addon.error(settled)
time.sleep(0.2)
results["errorSkippedWhenResponseExists"] = len(received) == 0

addon.http_connect_error(FakeFlow(error="no route to host"))
results["connectErrorFrames"] = wait_for(2)
results["connectErrorPaths"] = [item["path"].split("?")[0] for item in received]

received.clear()

# A request that fails before any response still has to build its request part; this is the path that
# broke when `_part` gained an argument, and the earlier case returns early without reaching it.
addon.error(FakeFlow(error="connection reset"))
results["errorWithoutResponseFrames"] = wait_for(1)
results["errorWithoutResponseMessage"] = received[0]["body"].get("error") if received else None

received.clear()

# The byte counter must return to zero once the queue drains, or the limit below would creep shut.
time.sleep(0.3)
results["queuedBytesAfterDrain"] = addon._queued_bytes

# Over the limit, a record is dropped rather than queued without bound.
_saved_limit = addon.QUEUE_BYTE_LIMIT
addon.QUEUE_BYTE_LIMIT = 16
addon._post("/response", {"id": "big", "res": {"body": "x" * 64}})
time.sleep(0.3)
results["oversizedRecordDropped"] = len(received) == 0
results["queuedBytesAfterDrop"] = addon._queued_bytes

# A bodyless record with a large URL: under body-only accounting its size was 0 and it was never
# dropped, so this is what the accounting change is for.
received.clear()
addon.QUEUE_BYTE_LIMIT = 500
addon._post("/request", {"id": "hdr", "method": "GET", "url": "https://a.test/" + "p" * 3000})
time.sleep(0.3)
results["bodylessRecordCounted"] = len(received) == 0
addon.QUEUE_BYTE_LIMIT = _saved_limit

results["urlQueryRedacted"] = addon._safe_url("https://a.test/cb?code=SECRET&state=xyz")
results["urlWithoutQueryUntouched"] = addon._safe_url("https://a.test/thing")
# Short pairs are the shape that EXPANDS under redaction (`a=1` -> `a=[REDACTED]`); a single long value
# shrinks, so it cannot detect a cap applied before redaction.
_expanding = "https://a.test/?" + "&".join(f"k{i}=1" for i in range(1000))
results["urlCappedExpanding"] = len(addon._safe_url(_expanding)) <= addon.MAX_URL_CHARS
results["urlCapped"] = len(addon._safe_url("https://a.test/?x=" + "y" * 99_000)) <= addon.MAX_URL_CHARS
results["urlBareTokenRedacted"] = addon._safe_url("https://a.test/cb?SECRETTOKEN")
print(json.dumps(results))
