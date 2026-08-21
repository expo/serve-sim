# Network capture: what is recorded, and what that means

Network capture decrypts a simulator's HTTPS traffic so it can be read. That is the feature, and it is
also the risk: a real app's traffic contains real credentials. This page says exactly what is recorded,
what is removed, what cannot be promised, where it is written, and how long it survives.

Read it before enabling capture on a device that talks to anything you care about.

## How it works, in one paragraph

A device booted with `--network-capture` runs a local mitmproxy for the life of its boot session, trusts
that proxy's certificate authority inside the simulator, and sets `DYLD_INSERT_LIBRARIES` in the
simulator's launchd so every app launched afterwards routes its `NSURLSession` traffic through the proxy.
Nothing on the host changes: no system proxy, no host keychain entry. The interception lives and dies with
the simulator's boot session.

## What is recorded

Every exchange the proxy sees, from **every app on that device** — not only the app you are looking at,
and not only apps you launched.

Always recorded:

- Method, full URL including query string, status, MIME type
- Byte counts, time to first byte, total duration, failure reason

Recorded only when asked for, via `--network-capture-field`:

| Field | Default | Contents |
| --- | --- | --- |
| `header` | **on** | Request and response headers, redacted (see below) |
| `request-body` | off | Request bodies, **not redacted** |
| `response-body` | off | Response bodies, **not redacted** |

Bodies are off by default deliberately. A request body is where passwords, refresh tokens, and
device-attestation blobs actually live, and unlike a header name there is no reliable way to find them
inside arbitrary JSON, protobuf, or form encoding.

To capture bodies, ask for them:

```bash
serve-sim <udid> --network-capture --network-capture-field header,request-body
```

Bodies are capped at 512 KB each, and 16 MB across the whole buffer.

## What is redacted

Header **values** are replaced with `[REDACTED]` when the header **name** reads as credential-bearing.
Two rules, both in `src/capture/redact.ts`:

1. **A pattern over the name.** Any header whose name contains `auth`, `authz`, `token`, `secret`,
   `password`, `credential`, `session`, `cookie`, `apikey`, `api-key`, `access-key`, `private-key`,
   `signature`, or `bearer` as a whole word. This is what catches `x-goog-api-key`, `x-refresh-token`,
   and `x-acme-session-id` without anyone enumerating them.
2. **A short list of names the pattern cannot match** — `authorization` and `proxy-authorization` (no word
   boundary after `auth`), `authentication`, `cookie2`, `set-cookie2`, `x-firebase-appcheck`,
   `x-amz-content-sha256`.

Redaction happens where the record is built, before it reaches the in-memory store, the panel, the stream,
or disk. The raw value is never held anywhere we would later have to remember to scrub.

## What cannot be guaranteed

This list is not a formality. Read it as the actual limit of the feature.

- **Bodies are never redacted.** Opting into `request-body` or `response-body` records whatever the app
  sent, verbatim. A login POST records the password. An OAuth exchange records the code and the refresh
  token.
- **A credential in an unusual header name survives.** The pattern matches names that read like
  credentials. A token in `x-acme-blob` does not, and is recorded in full.
- **Credentials in the URL survive.** Query strings are recorded in full, always, including
  `?access_token=…`. The URL is how a request is identified in the panel, so redacting it would make
  capture useless.
- **Redaction is name-based, not value-based.** There is no secret scanner. We do not try to detect
  JWT-shaped or key-shaped strings, and would not trust it if we did.
- **Capture is device-wide.** System services and every other app on that simulator are recorded too.

If you need a guarantee rather than a best effort, do not capture against production credentials. Use a
throwaway account or a staging environment.

## Where it is written, and for how long

Enabling capture writes to disk. There is no separate flag: with `--network-capture`, each device gets
`$TMPDIR/serve-sim/capture-<udid>/`, containing

| File | Contents |
| --- | --- |
| `network-capture.json` | One JSON record per exchange, appended |
| `capture.entries.ndjson` | One HAR entry per line, appended as requests settle |
| `capture.har` | A complete HAR document, rebuilt as entries arrive |

Each holds exactly what the field settings allowed, with redaction already applied. In memory the store is
bounded to 500 requests; **the files on disk are not bounded that way** and grow with the session.

Lifetime:

- The directory is removed when the session ends normally.
- Directories left by a crashed or killed run are swept at the next capture start.
- There is **no age-based expiry** while a session is live.
- On macOS `$TMPDIR` is per-user and mode `0700`, so another local user cannot read these files. That is a
  property of the platform, not something this code enforces — on a shared-`/tmp` host it would not hold.

## Remote and hosted use

The capture routes are reachable over HTTP. In a tunnelled or hosted setup, that means reachable by
anything that can reach the tunnel.

- Every capture route requires `Authorization: Bearer <session token>`, generated per server start, plus a
  same-origin check. The token is injected into the same-origin preview page and never appears in a URL.
- The rest of the serve-sim API is **not** token-gated today. Exposing an instance beyond loopback
  protects the capture data but not other endpoints.
- Nothing here uploads capture data. If a hosted deployment collects `$TMPDIR` or the process logs, that
  is a property of that deployment and has to be answered there — this code neither sends nor retains
  capture data past the session.

## Certificate pinning

An app that pins its certificate rejects the proxy's forged one, so its requests fail while the device is
capturing — for the whole boot session, not only while a panel is open. The failure is reported on the row
with pinning named as the cause. Reboot the device without capture to get that app working again.

Expo and React Native apps do not pin by default. Banking, payments, and apps deliberately using a pinning
library do.
