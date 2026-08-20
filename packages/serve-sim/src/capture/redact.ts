/** Best-effort header redaction. Not a secret scanner; bodies are untouched. */
const REDACTED = "[REDACTED]";

/** Known credential headers whose names carry no word the pattern below would catch. */
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-firebase-appcheck",
  "x-goog-iam-authorization-token",
  "x-amz-content-sha256",
]);

/**
 * Names that read as credential-bearing.
 *
 * The list above cannot keep up with vendor headers — `x-goog-api-key`, `x-firebase-appcheck`,
 * `x-amz-security-token`, whatever an app invents next. Matching the shape of the name instead means an
 * unknown header is redacted rather than recorded, which is the direction to fail in.
 */
const SENSITIVE_HEADER_PATTERN = /(^|[-_])(auth|authz|token|secret|password|passwd|credential|session|cookie|apikey|api[-_]?key|access[-_]?key|private[-_]?key|signature|bearer)([-_]|$)/i;

/** Whether a header's value would be redacted. Exported so the docs and tests agree on one rule. */
export function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_HEADER_NAMES.has(lower) || SENSITIVE_HEADER_PATTERN.test(lower);
}

/** Copy headers with sensitive values replaced. Names compared case-insensitively. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveHeaderName(name) ? REDACTED : value;
  }
  return out;
}
