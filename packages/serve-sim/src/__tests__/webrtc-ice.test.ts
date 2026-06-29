import { describe, expect, test } from "bun:test";
import { webRtcIceTransportPolicy } from "../client/webrtc-ice";

describe("webRtcIceTransportPolicy", () => {
  test("allows direct and STUN candidates when TURN is available", () => {
    expect(
      webRtcIceTransportPolicy([
        { urls: ["stun:stun.l.google.com:19302"] },
        {
          urls: ["turn:turn.example.com:3478"],
          username: "user",
          credential: "pass",
        },
      ])
    ).toBe("all");
  });
});
