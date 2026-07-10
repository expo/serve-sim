import { describe, expect, test } from "bun:test";
import { streamHelperArgs, streamRuntimeArgs } from "../stream-runtime-args";

describe("streamRuntimeArgs", () => {
  test("forwards HTTP codec options", () => {
    expect(
      streamRuntimeArgs({
        transport: "http",
        codec: "mjpeg",
      }),
    ).toEqual(["--transport", "http", "--codec", "mjpeg"]);
  });

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

describe("streamHelperArgs", () => {
  test("builds the re-exec arguments shared by detach and no-preview modes", () => {
    expect(streamHelperArgs("DEVICE-A", 3100, "127.0.0.1", {
      transport: "webrtc",
      codec: "vp9",
    })).toEqual([
      "DEVICE-A",
      "--port",
      "3100",
      "--host",
      "127.0.0.1",
      "--transport",
      "webrtc",
      "--webrtc-codec",
      "vp9",
    ]);
  });
});
