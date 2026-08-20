import { timingSafeEqual } from "node:crypto";

/** Minimal request surface used by the session token check. */
export interface SessionAuthReq {
  method?: string;
  headers: {
    "content-type"?: string | string[];
    origin?: string | string[];
    host?: string | string[];
    authorization?: string | string[];
    [key: string]: string | string[] | undefined;
  };
}

/** Minimal response surface used by the session token check. */
export interface SessionAuthRes {
  writeHead: (status: number, headers?: Record<string, string>) => unknown;
  end: (body?: string) => unknown;
}

export function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  // `application/json; charset=utf-8` etc. — only the media type matters.
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  return mediaType === "application/json";
}

export function captureAuthError(message: string): { error: string } {
  return { error: message };
}

export function execAuthError(message: string): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  return { stdout: "", stderr: message, exitCode: 1 };
}

/**
 * Assert session access for a privileged HTTP route: optional JSON content-type
 * (CSRF-simple POST), Origin↔Host when Origin is present, and Bearer token.
 *
 * Writes 415/403/401 and returns false when the request must stop; true to proceed.
 * Call explicitly at each protected route — there is no prefix auto-match.
 */
export function assertSessionAccess(
  req: SessionAuthReq,
  res: SessionAuthRes,
  sessionToken: string,
  opts: {
    requireJson: boolean;
    errorBody: (message: string) => unknown;
  },
): boolean {
  const writeErr = (status: number, message: string) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(opts.errorBody(message)));
  };
  if (opts.requireJson && !isJsonContentType(headerValue(req.headers["content-type"]))) {
    writeErr(415, "Unsupported Media Type");
    return false;
  }
  const origin = headerValue(req.headers.origin);
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== headerValue(req.headers.host)) {
        writeErr(403, "Cross-origin request blocked");
        return false;
      }
    } catch {
      writeErr(403, "Invalid Origin");
      return false;
    }
  }
  const authHeader = headerValue(req.headers.authorization) ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match || !safeEqualString(match[1]!.trim(), sessionToken)) {
    writeErr(401, "Unauthorized");
    return false;
  }
  return true;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
