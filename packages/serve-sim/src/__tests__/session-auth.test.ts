import { describe, expect, test } from "bun:test";

import {
  assertSessionAccess,
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
