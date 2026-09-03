import { describe, expect, test } from "bun:test";

import type { SessionAuthReq } from "../session-auth";
import {
  accessCookieName,
  assertPreviewAccess,
  assertUpgradeAccess,
  safeEqualString,
} from "../session-auth";

describe("safeEqualString", () => {
  test("compares equal strings", () => {
    expect(safeEqualString("abc", "abc")).toBe(true);
    expect(safeEqualString("abc", "abd")).toBe(false);
    expect(safeEqualString("abc", "ab")).toBe(false);
  });
});

describe("assertPreviewAccess", () => {
  const TOKEN = "s3cret-token";

  function res() {
    const sent: { status?: number; headers?: Record<string, string>; body?: string } = {};
    return {
      sent,
      res: {
        writeHead: (status: number, headers?: Record<string, string>) => {
          sent.status = status;
          sent.headers = headers;
        },
        end: (body?: string) => {
          sent.body = body;
        },
      },
    };
  }

  const req = (headers: Record<string, string> = {}, url = "/") => ({ headers, url });

  test("does not gate a loopback server, where the port already implies machine access", () => {
    const { sent, res: r } = res();
    expect(
      assertPreviewAccess(req(), r, TOKEN, { required: false, basePath: "/" }),
    ).toBe(true);
    expect(sent.status).toBeUndefined();
  });

  test("accepts the token as a bearer header, for callers that are not browsers", () => {
    const { res: r } = res();
    expect(
      assertPreviewAccess(req({ authorization: `Bearer ${TOKEN}` }), r, TOKEN, {
        required: true,
        basePath: "/",
      }),
    ).toBe(true);
  });

  test("trades a page navigation's query token for a cookie and redirects it out of the address bar", () => {
    const { sent, res: r } = res();
    expect(
      assertPreviewAccess(req({ "sec-fetch-dest": "document" }, `/?token=${TOKEN}&device=abc`), r, TOKEN, {
        required: true,
        basePath: "/",
      }),
    ).toBe(false);

    expect(sent.status).toBe(302);
    expect(sent.headers?.Location).toBe("/?device=abc");
    expect(sent.headers?.["Set-Cookie"]).toContain(`${accessCookieName(TOKEN)}=${encodeURIComponent(TOKEN)}`);
    expect(sent.headers?.["Set-Cookie"]).toContain("HttpOnly");
    // Strict would be withheld on the redirect that follows the token swap.
    expect(sent.headers?.["Set-Cookie"]).toContain("SameSite=Lax");
  });

  test("serves a cross-origin SSE/API query token directly, without a cookie redirect", () => {
    const { sent, res: r } = res();
    expect(
      assertPreviewAccess(
        req({ "sec-fetch-dest": "empty", accept: "text/event-stream" }, `/metrics?token=${TOKEN}`),
        r,
        TOKEN,
        { required: true, basePath: "/" },
      ),
    ).toBe(true);
    expect(sent.status).toBeUndefined();
  });

  test("accepts the cookie it set, so the page's own requests work", () => {
    const { res: r } = res();
    expect(
      assertPreviewAccess(req({ cookie: `${accessCookieName(TOKEN)}=${encodeURIComponent(TOKEN)}` }), r, TOKEN, {
        required: true,
        basePath: "/",
      }),
    ).toBe(true);
  });

  // The hop after the redirect still reports cross-site, which 401s the dashboard link.
  test("accepts the cookie on the navigation that follows the token redirect", () => {
    const { res: r } = res();
    expect(
      assertPreviewAccess(
        req({
          cookie: `${accessCookieName(TOKEN)}=${encodeURIComponent(TOKEN)}`,
          "sec-fetch-site": "cross-site",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
        }),
        r,
        TOKEN,
        { required: true, basePath: "/" },
      ),
    ).toBe(true);
  });

  // A subresource request can read the response, so it still needs the origin check.
  test("still refuses a cookie sent from another origin on a subresource request", () => {
    const { sent, res: r } = res();
    expect(
      assertPreviewAccess(
        req({
          cookie: `${accessCookieName(TOKEN)}=${encodeURIComponent(TOKEN)}`,
          "sec-fetch-site": "same-site",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
        }),
        r,
        TOKEN,
        { required: true, basePath: "/" },
      ),
    ).toBe(false);
    expect(sent.status).toBe(401);
  });

  test("does not redirect to another origin when the path normalizes to //", () => {
    const { sent, res: r } = res();
    assertPreviewAccess(req({ "sec-fetch-dest": "document" }, `/..//evil.example?token=${TOKEN}`), r, TOKEN, {
      required: true,
      basePath: "/",
    });

    expect(sent.status).toBe(302);
    expect(sent.headers?.Location).not.toMatch(/^\/\//);
  });

  test("refuses a caller with no token, and says how to get one", () => {
    const { sent, res: r } = res();
    expect(assertPreviewAccess(req(), r, TOKEN, { required: true, basePath: "/" })).toBe(false);
    expect(sent.status).toBe(401);
    expect(sent.body).toContain("token");
  });

  test("refuses a wrong token in every position it accepts a right one", () => {
    const wrong: Record<string, string>[] = [
      { authorization: "Bearer wrong" },
      { cookie: `${accessCookieName(TOKEN)}=wrong` },
    ];
    for (const headers of wrong) {
      const { sent, res: r } = res();
      expect(assertPreviewAccess(req(headers), r, TOKEN, { required: true, basePath: "/" })).toBe(
        false,
      );
      expect(sent.status).toBe(401);
    }
    const { sent, res: r } = res();
    expect(
      assertPreviewAccess(req({}, "/?token=wrong"), r, TOKEN, { required: true, basePath: "/" }),
    ).toBe(false);
    expect(sent.status).toBe(401);
  });
});

describe("assertUpgradeAccess", () => {
  const TOKEN = "s3cret-token";

  test("stays open when not required, so loopback upgrades are untouched", () => {
    expect(assertUpgradeAccess({}, TOKEN, { required: false })).toBe(true);
  });

  test("accepts the bearer a script holds", () => {
    expect(
      assertUpgradeAccess({ authorization: `Bearer ${TOKEN}` }, TOKEN, { required: true }),
    ).toBe(true);
  });

  test("accepts the cookie the page carries on its own sockets", () => {
    expect(
      assertUpgradeAccess(
        { cookie: `${accessCookieName(TOKEN)}=${encodeURIComponent(TOKEN)}` },
        TOKEN,
        { required: true },
      ),
    ).toBe(true);
  });

  test("refuses a ?token= query param, so the credential stays out of URLs and proxy logs", () => {
    expect(
      assertUpgradeAccess(
        { url: `/helper/x/ws?token=${encodeURIComponent(TOKEN)}` } as SessionAuthReq["headers"],
        TOKEN,
        { required: true },
      ),
    ).toBe(false);
  });

  // The call sites forward these headers for exactly this check.
  test("refuses a cookie-authenticated upgrade from another origin", () => {
    const cookie = `${accessCookieName(TOKEN)}=${encodeURIComponent(TOKEN)}`;
    expect(
      assertUpgradeAccess(
        { cookie, origin: "https://evil.example", host: "preview.example" },
        TOKEN,
        { required: true },
      ),
    ).toBe(false);
    expect(
      assertUpgradeAccess({ cookie, "sec-fetch-site": "cross-site" }, TOKEN, { required: true }),
    ).toBe(false);
  });

  test("accepts a cookie-authenticated upgrade from the preview's own origin", () => {
    const cookie = `${accessCookieName(TOKEN)}=${encodeURIComponent(TOKEN)}`;
    expect(
      assertUpgradeAccess(
        { cookie, origin: "https://preview.example", host: "preview.example" },
        TOKEN,
        { required: true },
      ),
    ).toBe(true);
  });

  test("refuses an upgrade with no token", () => {
    expect(assertUpgradeAccess({}, TOKEN, { required: true })).toBe(false);
  });

  test("refuses, without throwing, a malformed cookie on the synchronous upgrade path", () => {
    expect(() => assertUpgradeAccess({ cookie: `${accessCookieName(TOKEN)}=%` }, TOKEN, { required: true })).not.toThrow();
    expect(assertUpgradeAccess({ cookie: `${accessCookieName(TOKEN)}=%` }, TOKEN, { required: true })).toBe(false);
  });

  test("refuses a wrong token in either position", () => {
    expect(
      assertUpgradeAccess({ authorization: "Bearer wrong" }, TOKEN, { required: true }),
    ).toBe(false);
    expect(
      assertUpgradeAccess({ cookie: `${accessCookieName(TOKEN)}=wrong` }, TOKEN, { required: true }),
    ).toBe(false);
  });
});
