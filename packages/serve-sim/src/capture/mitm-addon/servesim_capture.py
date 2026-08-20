# Reports mitmproxy flows to the capture session control port.

import base64 as b64
import json
import os
import queue
import threading
import urllib.error
import urllib.request

CONTROL = os.environ.get("SERVE_SIM_CAPTURE_CONTROL_URL")
TOKEN = os.environ.get("SERVE_SIM_CAPTURE_CONTROL_TOKEN", "")
# Which parts of an exchange the session asked for. Absent means metadata only: the safe default is that
# nothing carrying credentials leaves this process.
FIELDS = {
    part.strip()
    for part in os.environ.get("SERVE_SIM_CAPTURE_FIELDS", "").split(",")
    if part.strip()
}
WANT_HEADERS = "header" in FIELDS
WANT_REQUEST_BODY = "request-body" in FIELDS
WANT_RESPONSE_BODY = "response-body" in FIELDS
# Query values are where OAuth codes, signed-URL credentials and reset tokens live. Names are kept so a
# developer can still tell one request from another; values never leave here unless asked for.
WANT_QUERY = "query" in FIELDS
REDACTED = "[REDACTED]"

MAX_BODY_BYTES = 512 * 1024
TIMEOUT_SECONDS = 2
QUEUE_BYTE_LIMIT = 32 * 1024 * 1024
# A record with no body still carries a URL, headers and an error string, none of which the body cap
# bounds. These cap each field before the record is built, so one hostile request cannot outweigh the
# queue limit on its own.
MAX_URL_CHARS = 4096
MAX_HEADER_NAME_CHARS = 256
MAX_HEADER_VALUE_CHARS = 4096
MAX_HEADERS = 100
MAX_ERROR_CHARS = 1024
# Item count matters as much as bytes: many tiny records still cost memory per object.
QUEUE_ITEM_LIMIT = 10_000

# Single worker preserves /request-before-/response order.
_outbox: "queue.Queue[tuple[str, bytes, int] | None]" = queue.Queue()
_queued_bytes = 0
_queued_lock = threading.Lock()

# Bypass http_proxy/HTTP_PROXY so records hit the loopback control port.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _send(path, body):
    request = urllib.request.Request(
        f"{CONTROL}{path}?t={TOKEN}",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        _opener.open(request, timeout=TIMEOUT_SECONDS).close()
    except Exception:
        pass


def _drain():
    global _queued_bytes
    while True:
        item = _outbox.get()
        if item is None:
            return
        path, body, size = item
        with _queued_lock:
            _queued_bytes -= size
        _send(path, body)


_reporter = threading.Thread(target=_drain, name="servesim-capture-reporter", daemon=True)
if CONTROL:
    _reporter.start()


def _clip(value, limit):
    text = "" if value is None else str(value)
    return text[:limit]


def _clip_headers(headers):
    # The wire bounds none of these, so cap count, name and value.
    out = {}
    for name, value in list(headers.items())[:MAX_HEADERS]:
        out[_clip(name, MAX_HEADER_NAME_CHARS)] = _clip(value, MAX_HEADER_VALUE_CHARS)
    return out


def _post(path, payload):
    global _queued_bytes
    if not CONTROL:
        return
    # Measure what is actually queued, not just its bodies: a bodyless request with huge headers or a
    # 100KB URL used to count as zero.
    body = json.dumps(payload).encode("utf-8")
    size = len(body)
    with _queued_lock:
        if _queued_bytes + size > QUEUE_BYTE_LIMIT or _outbox.qsize() >= QUEUE_ITEM_LIMIT:
            return
        _queued_bytes += size
    _outbox.put_nowait((path, body, size))


def running():
    _post("/ready", {"addon": "servesim_capture"})


def done():
    if not CONTROL:
        return
    _outbox.put_nowait(None)
    _reporter.join(timeout=2)


def _headers_of(message):
    # Headers only when asked for; redaction happens on the session side.
    if not WANT_HEADERS:
        return {}
    return _clip_headers({name.lower(): value for name, value in message.headers.items()})


def _mime_of(message):
    # Metadata, not a header dump: the panel labels every row with this, so it survives the default policy.
    value = message.headers.get("content-type") if hasattr(message, "headers") else None
    return _clip(value, MAX_HEADER_VALUE_CHARS) or None


def _safe_url(raw):
    # Names alone still identify a request; the values are what carry credentials.
    text = str(raw or "")
    if WANT_QUERY or "?" not in text:
        return _clip(text, MAX_URL_CHARS)
    head, _, query = text.partition("?")
    if not query:
        return _clip(head, MAX_URL_CHARS)
    parts = []
    for pair in query.split("&"):
        if not pair:
            continue
        name, sep, _value = pair.partition("=")
        # A pair with no `=` is a bare value — a signature or a token, never a name worth keeping.
        parts.append(f"{name}={REDACTED}" if sep else REDACTED)
    # Clipped last: redaction lengthens short values, so capping the input does not cap the output.
    return _clip(f"{head}?{'&'.join(parts)}", MAX_URL_CHARS)


def _part(message, want_body):
    # strict=False: mismatched content-encoding must not kill the hook.
    try:
        content = message.get_content(strict=False) or b""
    except (ValueError, TypeError):
        content = b""
    wire = message.raw_content or b""
    truncated = len(content) > MAX_BODY_BYTES
    head = content[:MAX_BODY_BYTES]
    if not want_body or not content:
        return {
            "headers": _headers_of(message),
            "mime": _mime_of(message),
            "size": len(wire),
            "decodedSize": 0,
            "body": "",
            "base64": None,
            "truncated": False,
        }
    try:
        text, encoded = head.decode("utf-8"), None
    except UnicodeDecodeError:
        text, encoded = None, b64.b64encode(head).decode("ascii")
    return {
        "headers": _headers_of(message),
        "mime": _mime_of(message),
        "size": len(wire),
        "decodedSize": len(content),
        "body": text,
        "base64": encoded,
        "truncated": truncated,
    }


def request(flow):
    _post(
        "/request",
        {"id": flow.id, "method": flow.request.method, "url": _safe_url(flow.request.pretty_url)},
    )


def response(flow):
    reply = flow.response
    started = flow.request.timestamp_start
    _post(
        "/response",
        {
            "id": flow.id,
            "status": reply.status_code,
            "ttfbMs": round((reply.timestamp_start - started) * 1000, 1),
            "durationMs": round((reply.timestamp_end - started) * 1000, 1),
            "req": _part(flow.request, WANT_REQUEST_BODY),
            "res": _part(reply, WANT_RESPONSE_BODY),
        },
    )


def error(flow):
    if flow.response is not None:
        return
    _post(
        "/response",
        {
            "id": flow.id,
            "status": None,
            "error": _clip(flow.error, MAX_ERROR_CHARS) or "the request failed before a response",
            "req": _part(flow.request, WANT_REQUEST_BODY),
        },
    )


def http_connect_error(flow):
    # CONNECT with no inner flow — request/error hooks never fire.
    _post(
        "/request",
        {
            "id": flow.id,
            "method": "CONNECT",
            "url": _clip(f"{flow.request.pretty_host}:{flow.request.port}", MAX_URL_CHARS),
        },
    )
    _post(
        "/response",
        {
            "id": flow.id,
            "status": None,
            "error": _clip(flow.error, MAX_ERROR_CHARS) or "could not connect to the host",
        },
    )
