import { describe, expect, test } from "bun:test";

import { iceServersToArgs } from "../../scripts/serve-turn";

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
