import { describe, expect, test } from "bun:test";
import { streamRuntimeArgs } from "../stream-runtime-args";

describe("streamRuntimeArgs", () => {
  test("forwards WebRTC transport, codec, STUN, and TURN options", () => {
    expect(
      streamRuntimeArgs({
        transport: "webrtc",
        codec: "vp8",
        iceServers: [
          { urls: ["stun:stun.example.com:19302"] },
          {
            urls: ["turn:turn.example.com:3478", "turns:turn.example.com:5349"],
            username: "user",
            credential: "pass",
          },
        ],
      }),
    ).toEqual([
      "--transport",
      "webrtc",
      "--webrtc-codec",
      "vp8",
      "--stun-url",
      "stun:stun.example.com:19302",
      "--turn-url",
      "turn:turn.example.com:3478,turns:turn.example.com:5349",
      "--turn-username",
      "user",
      "--turn-credential",
      "pass",
    ]);
  });
});
