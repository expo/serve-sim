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
function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match ? match[1]!.trim() : null;
}

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
  const bearer = bearerToken(headerValue(req.headers.authorization));
  if (!bearer || !safeEqualString(bearer, sessionToken)) {
    writeErr(401, "Unauthorized");
    return false;
  }
  return true;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Cookie the preview sets once the operator has proved they hold the token. */
export const ACCESS_COOKIE = "serve_sim_access";

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/**
 * Require the session token before serving anything that carries it.
 *
 * Loopback is ungated: reaching it means being on the machine already. Returns false when the request
 * has been answered and must stop.
 */
export function assertPreviewAccess(
  req: SessionAuthReq & { url?: string },
  res: SessionAuthRes,
  sessionToken: string,
  opts: { required: boolean; basePath: string },
): boolean {
  if (!opts.required) return true;

  const header = headerValue(req.headers.authorization);
  const fromBearer = bearerToken(header);
  if (fromBearer && safeEqualString(fromBearer, sessionToken)) return true;

  const cookie = cookieValue(headerValue(req.headers.cookie), ACCESS_COOKIE);
  if (cookie && safeEqualString(cookie, sessionToken)) return true;

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const fromQuery = url.searchParams.get("token");
  if (fromQuery && safeEqualString(fromQuery, sessionToken)) {
    url.searchParams.delete("token");
    res.writeHead(302, {
      Location: `${url.pathname}${url.search}`,
      "Set-Cookie": `${ACCESS_COOKIE}=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=${opts.basePath}`,
      "Cache-Control": "no-store, private",
    });
    res.end();
    return false;
  }

  res.writeHead(401, { "Content-Type": "text/plain", "Cache-Control": "no-store, private" });
  res.end(
    "Unauthorized. This serve-sim is bound to a non-loopback address, so the preview needs the access " +
      "token it printed at startup. Open the URL it logged, which carries `?token=`, or send the token " +
      "as `Authorization: Bearer <token>`.\n",
  );
  return false;
}
