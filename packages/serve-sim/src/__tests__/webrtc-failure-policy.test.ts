import { describe, expect, test } from "bun:test";
import {
  PLAYBACK_STALL_TIMEOUT_MS,
  shouldCheckPlaybackStall,
  webRtcFailureDisposition,
} from "../client/webrtc-failure-policy";

describe("WebRTC failure policy", () => {
  test("uses codec fallback only when a connected peer cannot decode its first frame", () => {
    expect(webRtcFailureDisposition("first-frame-timeout", "connected")).toBe("codec");
  });

  test("keeps waiting when media is arriving but has not rendered yet", () => {
    // A large first keyframe can arrive inside the connection and still paint after the
    // deadline; downgrading the codec there throws away a working stream.
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

describe("playback stall, after the stream has already painted", () => {
  /// The asymmetry is the point. Before the first paint, arriving RTP means be patient.
  /// After it, arriving RTP with nothing painting means the decoder stopped coping — most
  /// likely a frame larger than it can handle once the resolution moved up.
  test("blames the codec when media still arrives but nothing paints", () => {
    expect(webRtcFailureDisposition("playback-stall", "connected", { mediaArriving: true }))
      .toBe("codec");
  });

  test("blames the transport when media stopped arriving too", () => {
    expect(webRtcFailureDisposition("playback-stall", "connected", { mediaArriving: false }))
      .toBe("transport");
  });

  test("never waits, because a decoder that already choked will not recover on its own", () => {
    for (const arriving of [true, false]) {
      expect(webRtcFailureDisposition("playback-stall", "connected", { mediaArriving: arriving }))
        .not.toBe("wait");
    }
  });

  test("is the opposite of a first-frame timeout for the same inputs", () => {
    const progress = { mediaArriving: true };
    expect(webRtcFailureDisposition("first-frame-timeout", "connected", progress)).toBe("wait");
    expect(webRtcFailureDisposition("playback-stall", "connected", progress)).toBe("codec");
  });

  test("defers to the transport whenever the connection is not up", () => {
    for (const state of ["connecting", "disconnected", "failed", "closed", "new"] as const) {
      expect(webRtcFailureDisposition("playback-stall", state, { mediaArriving: true }))
        .toBe("transport");
    }
  });
});

describe("when a playback stall is worth checking at all", () => {
  const painted = { painted: true, msSincePaint: PLAYBACK_STALL_TIMEOUT_MS, documentHidden: false };

  test("checks once a painting stream has gone quiet for the whole window", () => {
    expect(shouldCheckPlaybackStall(painted)).toBe(true);
  });

  test("stays quiet inside the window", () => {
    expect(shouldCheckPlaybackStall({ ...painted, msSincePaint: PLAYBACK_STALL_TIMEOUT_MS - 1 }))
      .toBe(false);
  });

  /// requestVideoFrameCallback stops while the tab is hidden, so a backgrounded tab looks
  /// exactly like a dead decoder. Downgrading it would be the bug this watchdog guards.
  test("never fires for a hidden tab, however long the gap", () => {
    expect(shouldCheckPlaybackStall({ ...painted, documentHidden: true, msSincePaint: 600_000 }))
      .toBe(false);
  });

  test("leaves the pre-paint stream to the first-frame watchdog", () => {
    expect(shouldCheckPlaybackStall({ ...painted, painted: false, msSincePaint: 600_000 }))
      .toBe(false);
  });

  test("is generous enough to survive the idle floor", () => {
    // Capture holds 5 fps when nothing moves, so a healthy stream paints every ~200ms.
    expect(PLAYBACK_STALL_TIMEOUT_MS).toBeGreaterThanOrEqual(4_000);
    expect(shouldCheckPlaybackStall({ ...painted, msSincePaint: 1_000 })).toBe(false);
  });
});

