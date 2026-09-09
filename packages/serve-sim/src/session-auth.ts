import { createHash, timingSafeEqual } from "node:crypto";

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

export const ACCESS_COOKIE = "serve_sim_access";

// Cookies ignore the port, so two serve-sims on one host would overwrite each other's.
export function accessCookieName(sessionToken: string): string {
  const suffix = createHash("sha256").update(sessionToken).digest("hex").slice(0, 8);
  return `${ACCESS_COOKIE}_${suffix}`;
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      // Runs on the synchronous upgrade path, where an uncaught URIError would crash the process.
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}


// EAS terminates TLS at the tunnel, so the forwarded scheme is the only signal we get.
function isHttpsRequest(headers: SessionAuthReq["headers"]): boolean {
  const forwarded = headerValue(headers["x-forwarded-proto"]);
  if (forwarded) return forwarded.split(",", 1)[0]!.trim().toLowerCase() === "https";
  return false;
}

function accessCookie(sessionToken: string, basePath: string, secure: boolean): string {
  return [
    `${accessCookieName(sessionToken)}=${encodeURIComponent(sessionToken)}`,
    "HttpOnly",
    "SameSite=Lax",
    `Path=${basePath || "/"}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

// A cookie rides along on any same-site page's requests, so cookie auth must also prove the
// origin. A bearer or query token is presented deliberately and needs no such check.
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

function isDocumentNavigation(headers: SessionAuthReq["headers"]): boolean {
  const dest = headerValue(headers["sec-fetch-dest"]);
  if (dest !== undefined) return dest === "document";
  return (headerValue(headers["accept"]) ?? "").includes("text/html");
}

// A Lax cookie only rides a cross-site request when it is one of these, and that page cannot read
// the response. The hop after the token redirect still reports cross-site, so without this the
// dashboard link 401s on first load.
function isTopLevelNavigation(req: SessionAuthReq): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const mode = headerValue(req.headers["sec-fetch-mode"]);
  if (mode !== undefined && mode !== "navigate") return false;
  return isDocumentNavigation(req.headers);
}

// Returns false when the request has been answered and must stop.
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
    // A page load trades the token for a cookie so it leaves the address bar. A cross-origin
    // API/SSE caller can send neither header nor cookie, so it is served the query token directly.
    if (!isDocumentNavigation(req.headers)) {
      return true;
    }
    url.searchParams.delete("token");
    res.writeHead(302, {
      // A leading "//" would be read as an absolute cross-origin URL by the browser.
      Location: `${url.pathname.replace(/^\/+/, "/")}${url.search}`,
      "Set-Cookie": accessCookie(sessionToken, opts.basePath, isHttpsRequest(req.headers)),
      "Cache-Control": "no-store, private",
    });
    res.end();
    return false;
  }

  const fromBearer = bearerToken(headerValue(req.headers.authorization));
  if (fromBearer && safeEqualString(fromBearer, sessionToken)) return true;
  const fromCookie = cookieValue(headerValue(req.headers.cookie), accessCookieName(sessionToken));
  if (
    fromCookie &&
    safeEqualString(fromCookie, sessionToken) &&
    (isSameOriginRequest(req.headers) || isTopLevelNavigation(req))
  ) {
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

// No `?token=` fallback, so this credential never reaches a request URL or a proxy log.
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
