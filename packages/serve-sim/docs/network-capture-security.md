# Network capture: what is recorded, and what that means

Network capture decrypts a simulator's HTTPS traffic so it can be read. That is the feature, and it is
also the risk: a real app's traffic contains real credentials. This page says exactly what is recorded,
what is removed, what cannot be promised, where it is written, and how long it survives.

Read it before enabling capture on a device that talks to anything you care about.

## How it works, in one paragraph

A device booted with `--network-capture` runs a local mitmproxy for the life of its boot session, trusts
that proxy's certificate authority inside the simulator, and sets `DYLD_INSERT_LIBRARIES` in the
simulator's launchd so supported `NSURLSession` configurations in subsequently launched third-party apps
route traffic through the proxy. Apple system apps are excluded, and `URLSession.shared` bypasses capture.
Nothing on the host changes: no system proxy, no host keychain entry. The interception lives and dies with
the simulator's boot session.

## What is recorded

Every exchange the proxy sees from supported sessions in third-party apps on that device, including
apps other than the one you are looking at. This is not a complete record of device traffic.

Always recorded:

- Method, URL with its query values redacted, status, MIME type
- Byte counts, time to first byte, total duration, failure reason

Recorded only when you ask for it, via `--network-capture-field`. The default is metadata only:

| Field | Default | Contents |
| --- | --- | --- |
| `header` | off | Request and response headers, redacted (see below) |
| `query` | off | Query-string values; the names are kept either way |
| `request-body` | off | Request bodies, **not redacted** |
| `response-body` | off | Response bodies, **not redacted** |

All of it is off by default deliberately. Headers and query values carry credentials that redaction only
catches by name. A request body is worse: it is where passwords, refresh tokens, and device-attestation
blobs actually live, and unlike a header name there is no reliable way to find them inside arbitrary
JSON, protobuf, or form encoding.

To capture bodies, ask for them:

```bash
serve-sim <udid> --network-capture --network-capture-field header,request-body
```

Bodies are capped at 512 KB each, and 16 MB across the whole buffer.

## What is redacted

Header **values** are replaced with `[REDACTED]` when the header **name** reads as credential-bearing.
Three rules in `src/capture/redact.ts`:

1. **Delimited credential words.** Names containing words such as `auth`, `token`, `secret`, `password`,
   `session`, `cookie`, or `key` are redacted. This is conservative: it also catches non-secret headers
   such as `Idempotency-Key` and `Sec-WebSocket-Key`.
2. **Credential prefixes.** Names beginning with, or containing a delimited prefix such as,
   `authorization`, `authentication`, `sessionid`, `oidc`, `jwt`, `principal`, or `assertion` are redacted.
3. **Explicit names.** `cookie2`, `set-cookie2`, `x-firebase-appcheck`, and `x-amz-content-sha256`.

Redaction happens where the record is built, before it reaches the in-memory store, the panel, the stream,
or disk. The raw value is never held anywhere we would later have to remember to scrub.

## What cannot be guaranteed

This list is not a formality. Read it as the actual limit of the feature.

- **Bodies are never redacted.** Opting into `request-body` or `response-body` records whatever the app
  sent, verbatim. A login POST records the password. An OAuth exchange records the code and the refresh
  token.
- **A credential in an unusual header name survives.** The pattern matches names that read like
  credentials. A token in `x-acme-blob` does not, and is recorded in full.
- **A query name can be a credential on its own.** Query values are redacted unless `query` is asked for,
  but the names are always kept, and a name like `reset_token` already tells a reader what the request is.
- **Redaction is name-based, not value-based.** There is no secret scanner. We do not try to detect
  JWT-shaped or key-shaped strings, and would not trust it if we did.
- **Capture can include other apps.** Supported sessions in other third-party apps are recorded too.
  Apple system apps, `URLSession.shared`, and traffic that bypasses the configured proxy are not captured.

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

- Every capture route requires the session token, generated per server start, plus a same-origin check.
  The preview page carries the token for you. A caller of its own can send it as `Authorization: Bearer
  <token>` or as `?token=<token>`, and a URL is logged by every proxy it passes, so prefer the header.
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
