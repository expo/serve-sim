/** Best-effort header redaction. Not a secret scanner; bodies are untouched. */
const REDACTED = "[REDACTED]";

/** Credential headers no pattern would catch by shape alone. */
const SENSITIVE_HEADER_NAMES = new Set([
  "cookie2",
  "set-cookie2",
  "x-firebase-appcheck",
  "x-amz-content-sha256",
]);

/**
 * Names that read as credential-bearing.
 *
 * Matching the shape of the name means an unknown vendor header is redacted rather than recorded.
 */
const SENSITIVE_HEADER_PATTERN =
  /(^|[-_])(auth|authz|token|secret|password|passwd|credential|session|cookie|key|apikey|api[-_]?key|access[-_]?key|private[-_]?key|signature|bearer)([-_]|$)/i;

/**
 * The same words where the name runs on: `authorization`, `sessionid`.
 *
 * A reverse proxy re-presents the caller's credential under its own name — `x-forwarded-authorization`,
 * `x-amzn-oidc-accesstoken` — and those names all end in a word the pattern above needs a delimiter after.
 */
const SENSITIVE_HEADER_PREFIX_PATTERN =
  /(^|[-_])(authorization|authentication|sessionid|oidc|jwt|principal|assertion)/i;

/** Whether a header's value would be redacted. Exported so the docs and tests agree on one rule. */
export function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    SENSITIVE_HEADER_NAMES.has(lower)
    || SENSITIVE_HEADER_PATTERN.test(lower)
    || SENSITIVE_HEADER_PREFIX_PATTERN.test(lower)
  );
}

/** Copy headers with sensitive values replaced. Names compared case-insensitively. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveHeaderName(name) ? REDACTED : value;
  }
  return out;
}
