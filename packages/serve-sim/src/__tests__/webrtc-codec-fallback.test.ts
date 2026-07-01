import { describe, expect, test } from "bun:test";
import { nextWebRtcFallbackCodec } from "../client/webrtc-codec-fallback";

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
});
