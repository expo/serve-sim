import { describe, expect, test } from "bun:test";

import { corsAllowOriginHeaders, frameAncestorsPolicy } from "../middleware-utils";

describe("corsAllowOriginHeaders", () => {
  test("echoes an allowlisted origin, with Vary", () => {
    expect(corsAllowOriginHeaders("https://expo.dev", ["https://expo.dev"])).toEqual({
      "Access-Control-Allow-Origin": "https://expo.dev",
      Vary: "Origin",
    });
  });

  test("canonicalizes configured origins (case, default port, trailing slash) before matching", () => {
    for (const configured of ["HTTPS://Expo.Dev", "https://expo.dev:443", "https://expo.dev/"]) {
      expect(corsAllowOriginHeaders("https://expo.dev", [configured])).toEqual({
        "Access-Control-Allow-Origin": "https://expo.dev",
        Vary: "Origin",
      });
    }
  });

  test("skips a malformed configured origin instead of throwing", () => {
    expect(corsAllowOriginHeaders("https://expo.dev", ["not a url", "https://expo.dev"])).toEqual({
      "Access-Control-Allow-Origin": "https://expo.dev",
      Vary: "Origin",
    });
    expect(corsAllowOriginHeaders("https://expo.dev", ["not a url"])).toEqual({});
  });

  test("allows any loopback origin without config", () => {
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:8081", "http://[::1]:9000"]) {
      expect(corsAllowOriginHeaders(origin, [])).toEqual({
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
      });
    }
  });

  test("emits no header for an unlisted origin", () => {
    expect(corsAllowOriginHeaders("https://evil.example", ["https://expo.dev"])).toEqual({});
  });

  test("emits no header when the origin is absent or malformed", () => {
    expect(corsAllowOriginHeaders(null, ["https://expo.dev"])).toEqual({});
    expect(corsAllowOriginHeaders("not a url", ["https://expo.dev"])).toEqual({});
  });
});

describe("frameAncestorsPolicy", () => {
  test("names the origin allowed to embed the preview", () => {
    expect(frameAncestorsPolicy(["https://expo.dev"])).toBe("frame-ancestors 'self' https://expo.dev");
  });

  test("allows nobody else when no origin is configured", () => {
    expect(frameAncestorsPolicy([])).toBe("frame-ancestors 'self'");
  });

  test("drops a wildcard and an injected directive, which would otherwise widen the header", () => {
    expect(frameAncestorsPolicy(["*", "https://a; sandbox", "not a url", "https://expo.dev"])).toBe(
      "frame-ancestors 'self' https://expo.dev",
    );
  });

  test("canonicalizes, so a configured path or default port still matches", () => {
    expect(frameAncestorsPolicy(["https://expo.dev:443/dashboard"])).toBe(
      "frame-ancestors 'self' https://expo.dev",
    );
  });
});
