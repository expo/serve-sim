import { describe, expect, test } from "bun:test";

import {
  ACCESS_COOKIE,
  assertPreviewAccess,
  assertSessionAccess,
  assertUpgradeAccess,
  captureAuthError,
  execAuthError,
  isJsonContentType,
  safeEqualString,
} from "../session-auth";

describe("isJsonContentType", () => {
  test("accepts application/json with parameters", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
  });

  test("rejects missing or non-json types", () => {
    expect(isJsonContentType(undefined)).toBe(false);
    expect(isJsonContentType("text/plain")).toBe(false);
  });
});

describe("safeEqualString", () => {
  test("compares equal strings", () => {
    expect(safeEqualString("abc", "abc")).toBe(true);
    expect(safeEqualString("abc", "abd")).toBe(false);
    expect(safeEqualString("abc", "ab")).toBe(false);
  });
});

describe("assertSessionAccess", () => {
  function fakeRes() {
    const out: { status?: number; body?: string } = {};
    const res = {
      writeHead(status: number) {
        out.status = status;
      },
      end(body?: string) {
        out.body = body;
      },
    };
    return { res, out };
  }

  test("rejects non-json when requireJson", () => {
    const { res, out } = fakeRes();
    const ok = assertSessionAccess(
      { method: "POST", headers: { "content-type": "text/plain", authorization: "Bearer t" } },
      res,
      "t",
      { requireJson: true, errorBody: captureAuthError },
    );
    expect(ok).toBe(false);
    expect(out.status).toBe(415);
  });

  test("rejects cross-origin", () => {
    const { res, out } = fakeRes();
    const ok = assertSessionAccess(
      {
        method: "GET",
        headers: {
          authorization: "Bearer secret",
          origin: "http://evil.example",
          host: "127.0.0.1:3200",
        },
      },
      res,
      "secret",
      { requireJson: false, errorBody: captureAuthError },
    );
    expect(ok).toBe(false);
    expect(out.status).toBe(403);
  });

  test("rejects missing bearer", () => {
    const { res, out } = fakeRes();
    const ok = assertSessionAccess(
      { method: "GET", headers: {} },
      res,
      "secret",
      { requireJson: false, errorBody: execAuthError },
    );
    expect(ok).toBe(false);
    expect(out.status).toBe(401);
  });

  test("accepts bearer + same-origin", () => {
    const { res, out } = fakeRes();
    const ok = assertSessionAccess(
      {
        method: "GET",
        headers: {
          authorization: "Bearer secret",
          origin: "http://127.0.0.1:3200",
          host: "127.0.0.1:3200",
        },
      },
      res,
      "secret",
      { requireJson: false, errorBody: execAuthError },
    );
    expect(ok).toBe(true);
    expect(out.status).toBeUndefined();
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
    expect(sent.headers?.["Set-Cookie"]).toContain(`${ACCESS_COOKIE}=${encodeURIComponent(TOKEN)}`);
    expect(sent.headers?.["Set-Cookie"]).toContain("HttpOnly");
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
      assertPreviewAccess(req({ cookie: `${ACCESS_COOKIE}=${encodeURIComponent(TOKEN)}` }), r, TOKEN, {
        required: true,
        basePath: "/",
      }),
    ).toBe(true);
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
      { cookie: `${ACCESS_COOKIE}=wrong` },
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
        { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(TOKEN)}` },
        TOKEN,
        { required: true },
      ),
    ).toBe(true);
  });

  test("accepts a ?token= query param, for the global-WebSocket CLI subcommands", () => {
    expect(
      assertUpgradeAccess({ url: `/helper/x/ws?token=${encodeURIComponent(TOKEN)}` }, TOKEN, {
        required: true,
      }),
    ).toBe(true);
    expect(
      assertUpgradeAccess({ url: `/helper/x/ws?token=wrong` }, TOKEN, { required: true }),
    ).toBe(false);
  });

  test("refuses an upgrade with no token", () => {
    expect(assertUpgradeAccess({}, TOKEN, { required: true })).toBe(false);
  });

  test("refuses, without throwing, a malformed cookie on the synchronous upgrade path", () => {
    expect(() => assertUpgradeAccess({ cookie: `${ACCESS_COOKIE}=%` }, TOKEN, { required: true })).not.toThrow();
    expect(assertUpgradeAccess({ cookie: `${ACCESS_COOKIE}=%` }, TOKEN, { required: true })).toBe(false);
  });

  test("refuses a wrong token in either position", () => {
    expect(
      assertUpgradeAccess({ authorization: "Bearer wrong" }, TOKEN, { required: true }),
    ).toBe(false);
    expect(
      assertUpgradeAccess({ cookie: `${ACCESS_COOKIE}=wrong` }, TOKEN, { required: true }),
    ).toBe(false);
  });
});
