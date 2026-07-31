# Reports what mitmproxy saw to the capture session that started it. Forwards only; the session owns the
# store and the streamed record.
#
# `response` fires only after the whole body is read, and `error` is mutually exclusive with it — so a
# record is complete when it arrives, and a failure is a reason rather than a synthesised status.

import base64 as b64
import json
import os
import queue
import threading
import urllib.error
import urllib.request

CONTROL = os.environ.get("EXPO_CAPTURE_CONTROL_URL")
TOKEN = os.environ.get("EXPO_CAPTURE_CONTROL_TOKEN", "")

# Matches the store's own per-body cap, so the control port never carries a payload the session would
# only discard. Truncation is reported rather than hidden: a cut body and an absent one differ.
MAX_BODY_BYTES = 512 * 1024

# A dropped record must never hold up the request it describes.
TIMEOUT_SECONDS = 2

# Bounded by bytes rather than by item count.
#
# A count bound is not a memory bound here: each item can carry two bodies near the 512KB cap, so 2048
# items is a couple of gigabytes held inside the proxy. Reporting is best-effort, and dropping the newest
# record is better than growing without limit.
QUEUE_BYTE_LIMIT = 32 * 1024 * 1024

# Reports leave on their own thread.
#
# Hooks run on mitmproxy's event loop, and posting from them directly would block that loop on a socket
# for every request and every response — serialising the proxy and adding the round-trip to the latency
# of the app's own traffic. Handing the record to a queue keeps the hooks non-blocking; ordering is still
# guaranteed because a single worker drains it in order, which `/request` before `/response` relies on.
_outbox: "queue.Queue[tuple[str, dict, int] | None]" = queue.Queue()
_queued_bytes = 0
_queued_lock = threading.Lock()


# Reports must never travel through a proxy.
#
# `urlopen` honours `http_proxy`/`HTTP_PROXY` (and macOS System Settings) by default, and the engine hands
# mitmproxy the whole environment. A developer with a corporate proxy configured would therefore send
# every record to that proxy instead of to the loopback control port, and `_send` would swallow each
# failure — capture would report itself healthy and record nothing at all.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _send(path, payload):
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{CONTROL}{path}?t={TOKEN}",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        _opener.open(request, timeout=TIMEOUT_SECONDS).close()
    except (urllib.error.URLError, OSError, TimeoutError):
        # The session may be tearing down. Losing a row is preferable to holding the proxy up.
        pass


def _drain():
    global _queued_bytes
    while True:
        item = _outbox.get()
        if item is None:
            return
        path, payload, size = item
        with _queued_lock:
            _queued_bytes -= size
        _send(path, payload)


# Daemon, so it never keeps mitmproxy alive past shutdown; `done()` gives it a chance to flush first.
_reporter = threading.Thread(target=_drain, name="expocapture-reporter", daemon=True)
if CONTROL:
    _reporter.start()


def _post(path, payload):
    global _queued_bytes
    if not CONTROL:
        return
    size = len(payload.get("req", {}).get("body") or "") + len(payload.get("res", {}).get("body") or "")
    size += len(payload.get("req", {}).get("base64") or "") + len(payload.get("res", {}).get("base64") or "")
    with _queued_lock:
        if _queued_bytes + size > QUEUE_BYTE_LIMIT:
            # The session is not keeping up. A dropped `/request` also voids its `/response`, so the row
            # is lost rather than left in flight for good.
            return
        _queued_bytes += size
    _outbox.put_nowait((path, payload, size))


def running():
    """
    Tells the session the addon is live.

    Without this, readiness was inferred from mitmproxy having written its certificate — which it does
    even when this file fails to import, and even moments before exiting because of it. A capture whose
    addon never loaded would report itself as running and then show an empty list forever. Nothing but
    this message proves the hooks below are actually installed.
    """
    _post("/ready", {"addon": "expocapture"})


def done():
    """Flush what is queued before mitmproxy exits, since the reporter thread is a daemon."""
    if not CONTROL:
        return
    _outbox.put_nowait(None)
    _reporter.join(timeout=2)


def _part(message):
    """
    Headers, byte count, and a bounded body, in the shape the session expects.

    Two things matter here. `message.content` decodes strictly and *raises* on a body whose
    `content-encoding` does not match its bytes — which would kill the hook, so the record would never be
    sent and its row would spin forever; `get_content(strict=False)` returns the raw bytes instead. And
    the byte count comes from `raw_content`, what actually crossed the wire, not from the decompressed
    length: reporting the latter overstated a gzipped response by several hundred times and made
    throughput meaningless.
    """
    try:
        content = message.get_content(strict=False) or b""
    except (ValueError, TypeError):
        content = b""
    wire = message.raw_content or b""
    truncated = len(content) > MAX_BODY_BYTES
    head = content[:MAX_BODY_BYTES]
    if not content:
        return {
            "headers": {name.lower(): value for name, value in message.headers.items()},
            "size": len(wire),
            "decodedSize": 0,
            "body": "",
            "base64": None,
            "truncated": False,
        }
    try:
        text, encoded = head.decode("utf-8"), None
    except UnicodeDecodeError:
        # Binary and still-compressed bodies travel as base64; the session decides how to present them.
        text, encoded = None, b64.b64encode(head).decode("ascii")
    return {
        "headers": {name.lower(): value for name, value in message.headers.items()},
        # What crossed the wire, so throughput reflects bytes moved rather than bytes after decompression.
        "size": len(wire),
        # The decoded length, for a panel that wants to say how big the body it is showing is.
        "decodedSize": len(content),
        "body": text,
        "base64": encoded,
        "truncated": truncated,
    }


def request(flow):
    """Opens the row, so the panel can show a request while it is still in flight."""
    _post(
        "/request",
        {"id": flow.id, "method": flow.request.method, "url": flow.request.pretty_url},
    )


def response(flow):
    """Settles the row. The body is complete here — that is this hook's contract."""
    reply = flow.response
    started = flow.request.timestamp_start
    _post(
        "/response",
        {
            "id": flow.id,
            "status": reply.status_code,
            "ttfbMs": round((reply.timestamp_start - started) * 1000, 1),
            "durationMs": round((reply.timestamp_end - started) * 1000, 1),
            "req": _part(flow.request),
            "res": _part(reply),
        },
    )


def error(flow):
    """The origin was never reached. Reported as a failure reason rather than as a status code."""
    if flow.response is not None:
        return  # a response arrived after all; `response` has already reported it
    _post(
        "/response",
        {
            "id": flow.id,
            "status": None,
            "error": str(flow.error) if flow.error else "the request failed before a response",
            "req": _part(flow.request),
        },
    )


def http_connect_error(flow):
    """
    A CONNECT that never established, so no request ever existed inside it.

    Without this an HTTPS request to an unreachable host produces nothing at all: `request` never fires
    because there is no inner flow, and `error` only covers flows that got that far. The developer would
    see an empty panel and no reason for it, which is the failure mode this whole engine exists to avoid.
    """
    _post(
        "/request",
        {"id": flow.id, "method": "CONNECT", "url": f"{flow.request.pretty_host}:{flow.request.port}"},
    )
    _post(
        "/response",
        {
            "id": flow.id,
            "status": None,
            "error": str(flow.error) if flow.error else "could not connect to the host",
        },
    )
