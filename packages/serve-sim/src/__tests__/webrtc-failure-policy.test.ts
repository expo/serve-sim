import { describe, expect, test } from "bun:test";
import { webRtcFailureDisposition } from "../client/webrtc-failure-policy";

describe("WebRTC failure policy", () => {
  test("uses codec fallback only when a connected peer cannot decode its first frame", () => {
    expect(webRtcFailureDisposition("first-frame-timeout", "connected")).toBe("codec");
  });

  test("keeps waiting when media is arriving but has not rendered yet", () => {
    // A large first keyframe can take longer than the watchdog to arrive and render.
    // Measured on a Tart guest at 1206x2622: hardware H.264 streamed correctly but the
    // browser had not painted within 4s, so a healthy stream was declared a codec failure
    // and permanently downgraded to software VP8. If RTP is flowing it is not the codec.
    expect(webRtcFailureDisposition("first-frame-timeout", "connected", { mediaArriving: true }))
      .toBe("wait");
  });

  test("still blames the codec when nothing at all is arriving", () => {
    expect(webRtcFailureDisposition("first-frame-timeout", "connected", { mediaArriving: false }))
      .toBe("codec");
  });

  test("retries transport when the peer never connected", () => {
    expect(webRtcFailureDisposition("first-frame-timeout", "connecting")).toBe("transport");
  });

  test("does not reinterpret signaling or established connection failures as codec failures", () => {
    expect(webRtcFailureDisposition("signaling-failed", "new")).toBe("transport");
    expect(webRtcFailureDisposition("connection-failed", "failed")).toBe("transport");
  });
});
