import { describe, expect, test } from "bun:test";

import { describeSecret, iceServersToArgs } from "../../scripts/serve-turn";

describe("iceServersToArgs", () => {
  test("splits Cloudflare's reply into stun urls and one turn entry", () => {
    const args = iceServersToArgs([
      { urls: "stun:stun.cloudflare.com:3478" },
      {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349"],
        username: "user",
        credential: "secret",
      },
    ]);

    expect(args).toEqual([
      "--stun-url", "stun:stun.cloudflare.com:3478",
      "--turn-url", "turn:turn.cloudflare.com:3478?transport=udp,turns:turn.cloudflare.com:5349",
      "--turn-username", "user",
      "--turn-credential", "secret",
    ]);
  });

  test("omits turn flags when no credentialled server came back, so the caller can tell", () => {
    expect(iceServersToArgs([{ urls: "stun:stun.cloudflare.com:3478" }])).toEqual([
      "--stun-url", "stun:stun.cloudflare.com:3478",
    ]);
  });

  test("accepts a single object where the urls field is a bare string", () => {
    const args = iceServersToArgs([{ urls: "turn:one:3478", username: "u", credential: "c" }]);

    expect(args).toEqual(["--turn-url", "turn:one:3478", "--turn-username", "u", "--turn-credential", "c"]);
  });

  test("returns nothing for an empty list rather than half a flag", () => {
    expect(iceServersToArgs([])).toEqual([]);
  });
});

describe("describeSecret", () => {
  test("reports shape without ever including the value", () => {
    const description = describeSecret("deadbeef0123");

    expect(description).toBe("12 chars, hex");
    expect(description).not.toContain("deadbeef");
  });

  test("calls out surrounding whitespace, the thing that breaks the URL", () => {
    expect(describeSecret("abc123\n")).toContain("had surrounding whitespace");
  });

  test("distinguishes a token from a hex id", () => {
    expect(describeSecret("v1.0-abc_DEF")).toContain("token-safe");
    expect(describeSecret("has spaces here")).toContain("unusual characters");
  });
});
