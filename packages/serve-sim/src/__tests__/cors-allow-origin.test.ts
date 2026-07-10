import { describe, expect, test } from "bun:test";

import { corsAllowOriginHeaders } from "../middleware-utils";

describe("corsAllowOriginHeaders", () => {
  test("echoes an allowlisted origin, with Vary", () => {
    expect(corsAllowOriginHeaders("https://expo.dev", ["https://expo.dev"])).toEqual({
      "Access-Control-Allow-Origin": "https://expo.dev",
      Vary: "Origin",
    });
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
