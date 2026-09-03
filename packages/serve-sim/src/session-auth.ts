import { createHash, timingSafeEqual } from "node:crypto";

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

/**
 * Cookie name for one server. Cookies ignore the port, so two serve-sims on the same host would
 * otherwise overwrite each other's access cookie. The suffix comes from the session token, so every
 * server owns a distinct name without having to know the port it was reached on.
 */
export function accessCookieName(sessionToken: string): string {
  const suffix = createHash("sha256").update(sessionToken).digest("hex").slice(0, 8);
  return `${ACCESS_COOKIE}_${suffix}`;
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      // A malformed percent-encoding must not throw: this runs on the synchronous upgrade path,
      // where an uncaught URIError would crash the process. A bad cookie is simply not a match.
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}


/**
 * Whether the preview is reached over HTTPS. EAS fronts serve-sim with an HTTPS tunnel that
 * terminates TLS, so the proxy's forwarded scheme is the only signal the origin server sees.
 */
function isHttpsRequest(headers: SessionAuthReq["headers"]): boolean {
  const forwarded = headerValue(headers["x-forwarded-proto"]);
  if (forwarded) return forwarded.split(",", 1)[0]!.trim().toLowerCase() === "https";
  return false;
}

/** The root mount normalizes its base path to "", which is not a valid cookie Path. */
function accessCookie(sessionToken: string, basePath: string, secure: boolean): string {
  return [
    `${accessCookieName(sessionToken)}=${encodeURIComponent(sessionToken)}`,
    "HttpOnly",
    "SameSite=Lax",
    `Path=${basePath || "/"}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * Whether a browser request came from the preview's own origin. A cookie rides along on any request
 * a same-site page makes, so cookie-authenticated callers must also prove the origin; a bearer or
 * query token is presented deliberately and needs no such check.
 */
function isSameOriginRequest(headers: SessionAuthReq["headers"]): boolean {
  const site = headerValue(headers["sec-fetch-site"]);
  if (site !== undefined) return site === "same-origin" || site === "none";
  const origin = headerValue(headers.origin);
  if (!origin) return true;
  try {
    return new URL(origin).host === headerValue(headers.host);
  } catch {
    return false;
  }
}

/** Whether the request is a top-level page navigation (rather than a fetch/XHR/EventSource). */
function isDocumentNavigation(headers: SessionAuthReq["headers"]): boolean {
  const dest = headerValue(headers["sec-fetch-dest"]);
  if (dest !== undefined) return dest === "document";
  // Older clients without Sec-Fetch-Dest: fall back to the Accept header.
  return (headerValue(headers["accept"]) ?? "").includes("text/html");
}

/**
 * Require the session token before serving anything that carries it.
 *
 * Off unless `--require-token` is set; when on, every gated route needs the token regardless of the
 * bind address. Returns false when the request has been answered and must stop.
 */
export function assertPreviewAccess(
  req: SessionAuthReq & { url?: string },
  res: SessionAuthRes,
  sessionToken: string,
  opts: { required: boolean; basePath: string },
): boolean {
  if (!opts.required) return true;

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const fromQuery = url.searchParams.get("token");
  if (fromQuery && safeEqualString(fromQuery, sessionToken)) {
    // A top-level page load trades the token for a cookie so it never lingers in the address bar. A
    // cross-origin API/SSE caller (e.g. the dashboard's metrics EventSource) cannot send a header or a
    // cookie at all, so it must be served directly with the query token instead of redirected.
    if (!isDocumentNavigation(req.headers)) {
      return true;
    }
    url.searchParams.delete("token");
    res.writeHead(302, {
      Location: `${url.pathname}${url.search}`,
      "Set-Cookie": accessCookie(sessionToken, opts.basePath, isHttpsRequest(req.headers)),
      "Cache-Control": "no-store, private",
    });
    res.end();
    return false;
  }

  const fromBearer = bearerToken(headerValue(req.headers.authorization));
  if (fromBearer && safeEqualString(fromBearer, sessionToken)) return true;
  const fromCookie = cookieValue(headerValue(req.headers.cookie), accessCookieName(sessionToken));
  if (fromCookie && safeEqualString(fromCookie, sessionToken) && isSameOriginRequest(req.headers)) {
    return true;
  }

  res.writeHead(401, { "Content-Type": "text/plain", "Cache-Control": "no-store, private" });
  res.end(
    "Unauthorized. This serve-sim was started with --require-token, so the preview needs the access " +
      "token it printed at startup. Open the URL it logged, which carries `?token=`, or send the token " +
      "as `Authorization: Bearer <token>`.\n",
  );
  return false;
}

/**
 * Gate a WebSocket upgrade: a bearer header, or the access cookie the page already holds on a
 * same-origin request. The page's own sockets are same-origin and send the cookie; every other
 * caller sends the header. There is no `?token=` fallback, so this credential never reaches a
 * request URL or a proxy log. There is no redirect either (an upgrade cannot). Returns false when
 * the socket must be closed.
 */
export function assertUpgradeAccess(
  req: SessionAuthReq["headers"],
  sessionToken: string,
  opts: { required: boolean },
): boolean {
  if (!opts.required) return true;
  const fromBearer = bearerToken(headerValue(req.authorization));
  if (fromBearer && safeEqualString(fromBearer, sessionToken)) return true;
  const fromCookie = cookieValue(headerValue(req.cookie), accessCookieName(sessionToken));
  return !!fromCookie && safeEqualString(fromCookie, sessionToken) && isSameOriginRequest(req);
}
