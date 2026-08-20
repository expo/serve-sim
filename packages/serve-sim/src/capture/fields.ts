import type { CapturedBody } from "./store";

/** Allowlisted pieces of each captured exchange (CLI: `--network-capture-field`). */
export const CAPTURE_FIELDS = ["header", "query", "request-body", "response-body"] as const;

export type CaptureField = (typeof CAPTURE_FIELDS)[number];

/**
 * Default: metadata only — method, URL path, status, timing, MIME type and sizes.
 *
 * Everything else is asked for explicitly, because everything else can carry a credential. Query values
 * hold OAuth codes and signed-URL keys, headers hold tokens and cookies, and bodies hold passwords with
 * no reliable way to find them inside arbitrary JSON or protobuf. Header redaction is best-effort and
 * body capture has no redaction at all, so neither is something to turn on for someone.
 */
export const DEFAULT_CAPTURE_FIELDS: readonly CaptureField[] = [];

const CAPTURE_FIELD_SET = new Set<string>(CAPTURE_FIELDS);

export function isCaptureField(value: string): value is CaptureField {
  return CAPTURE_FIELD_SET.has(value);
}

/**
 * Parse CLI / config field tokens. Accepts repeated flags and comma-separated
 * lists (`header,request-body`). Dedupes; rejects unknown names.
 */
export function parseCaptureFields(values: readonly string[]): CaptureField[] {
  const out: CaptureField[] = [];
  const seen = new Set<CaptureField>();
  for (const raw of values) {
    for (const part of raw.split(",")) {
      const value = part.trim().toLowerCase();
      if (!value) continue;
      if (!isCaptureField(value)) {
        throw new Error(
          `Unknown network capture field '${part.trim()}'. Supported: ${CAPTURE_FIELDS.join(", ")}.`,
        );
      }
      if (!seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    }
  }
  return out;
}

/** Resolve fields for a session: explicit list, or {@link DEFAULT_CAPTURE_FIELDS} when empty. */
export function resolveCaptureFields(values: readonly string[] | undefined): CaptureField[] {
  if (!values || values.length === 0) return [...DEFAULT_CAPTURE_FIELDS];
  return parseCaptureFields(values);
}

export function captureFieldSet(fields: readonly CaptureField[]): ReadonlySet<CaptureField> {
  return new Set(fields);
}

/** Drop disallowed header/body slots before store / disk / HAR. */
export function applyCaptureFields(
  body: CapturedBody,
  fields: ReadonlySet<CaptureField>,
): CapturedBody {
  const keepHeaders = fields.has("header");
  const keepRequest = fields.has("request-body");
  const keepResponse = fields.has("response-body");
  return {
    requestHeaders: keepHeaders ? body.requestHeaders : {},
    responseHeaders: keepHeaders ? body.responseHeaders : {},
    requestBody: keepRequest ? body.requestBody : null,
    responseBody: keepResponse ? body.responseBody : null,
    requestTruncated: keepRequest ? body.requestTruncated : false,
    responseTruncated: keepResponse ? body.responseTruncated : false,
    requestBinary: keepRequest ? body.requestBinary : false,
    responseBinary: keepResponse ? body.responseBinary : false,
  };
}
