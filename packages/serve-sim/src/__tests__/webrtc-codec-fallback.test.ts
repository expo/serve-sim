import { describe, expect, test } from "bun:test";
import {
  negotiatedWebRtcCodecFromSdp,
  nextWebRtcFallbackCodec,
} from "../client/webrtc-codec-fallback";

describe("nextWebRtcFallbackCodec", () => {
  test("tries VP8 before VP9 when H264 produces no media", () => {
    expect(nextWebRtcFallbackCodec("h264", "h264")).toBe("vp8");
    expect(nextWebRtcFallbackCodec("h264", "vp8")).toBe("vp9");
    expect(nextWebRtcFallbackCodec("h264", "vp9")).toBe(null);
  });

  test("falls back from VP9 to mandatory VP8", () => {
    expect(nextWebRtcFallbackCodec("vp9", "vp9")).toBe("vp8");
    expect(nextWebRtcFallbackCodec("vp9", "vp8")).toBe(null);
  });

  test("reads the first negotiated video codec from an answer SDP", () => {
    expect(negotiatedWebRtcCodecFromSdp([
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=rtpmap:111 opus/48000/2",
      "m=video 9 UDP/TLS/RTP/SAVPF 96 97 109",
      "a=rtpmap:109 H264/90000",
      "a=rtpmap:96 VP8/90000",
      "a=rtpmap:97 rtx/90000",
    ].join("\r\n"))).toBe("vp8");
  });
});
