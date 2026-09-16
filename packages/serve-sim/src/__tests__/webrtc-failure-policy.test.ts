import { describe, expect, test } from "bun:test";
import {
  initialPlaybackStallState,
  nextPlaybackStallState,
  PLAYBACK_STALL_POLLS,
  webRtcFailureDisposition,
  type PlaybackProgress,
  type PlaybackStallState,
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

describe("tracking whether decoding has stopped", () => {
  const run = (samples: PlaybackProgress[]) => {
    let state: PlaybackStallState = initialPlaybackStallState;
    const stalls: boolean[] = [];
    for (const sample of samples) {
      const next = nextPlaybackStallState(state, sample);
      stalls.push(next.stalled);
      state = next.stalled ? initialPlaybackStallState : next.state;
    }
    return stalls;
  };
  const frozen = (count: number, from = 100): PlaybackProgress[] =>
    Array.from({ length: count }, (_, i) => ({ decoded: from, received: 1_000 + i * 50 }));

  test("a stream whose decode counter keeps moving never stalls", () => {
    const samples = Array.from({ length: 20 }, (_, i) => ({ decoded: i * 30, received: i * 40 }));
    expect(run(samples)).not.toContain(true);
  });

  test("reports a stall only after consecutive polls with no decoding", () => {
    const stalls = run(frozen(PLAYBACK_STALL_POLLS + 1));
    expect(stalls.slice(0, PLAYBACK_STALL_POLLS)).not.toContain(true);
    expect(stalls[PLAYBACK_STALL_POLLS]).toBe(true);
  });

  /// A hidden tab's interval is throttled or suspended, so wall-clock elapsed there says
  /// nothing. Counting polls means a suspended interval simply never accumulates.
  test("a long gap between polls is not itself a stall", () => {
    expect(run([{ decoded: 5, received: 10 }, { decoded: 9, received: 99 }])).not.toContain(true);
  });

  /// Absent is not zero: a browser that does not report the counter must not be read as a
  /// decoder that stopped.
  test("never stalls while the decode counter is unavailable", () => {
    const samples = Array.from({ length: 20 }, (_, i) => ({ decoded: null, received: i * 40 }));
    expect(run(samples)).not.toContain(true);
  });

  test("a counter that goes backwards re-baselines instead of accusing the decoder", () => {
    // A replaced inbound-rtp report restarts at zero while the stream keeps running.
    const samples = [
      { decoded: 100, received: 1_000 },
      ...[0, 1, 2, 3, 4, 5, 6].map((d, i) => ({ decoded: d, received: 2_000 + i * 50 })),
    ];
    expect(run(samples)).not.toContain(true);
  });

  /// Packet loss keeps bytes climbing while no frame ever completes. Reproduced in Chrome:
  /// framesReceived frozen at 1499, bytes 35.1M -> 36.8M, packetsLost 5 -> 73. Changing codec
  /// cannot repair that, so it must not spend one of the ladder's attempts.
  test("packet loss that stops whole frames is the transport, not the codec", () => {
    const lossy = nextPlaybackStallState(
      { decoded: 1_499, received: 1_499, stalledPolls: PLAYBACK_STALL_POLLS - 1 },
      { decoded: 1_499, received: 1_499 },
    );
    expect(lossy.stalled).toBe(true);
    expect(lossy.mediaArriving).toBe(false);
    expect(webRtcFailureDisposition("playback-stall", "connected", lossy)).toBe("transport");
  });

  test("distinguishes a dead decoder from a dead transport", () => {
    const arriving = nextPlaybackStallState(
      { decoded: 10, received: 100, stalledPolls: PLAYBACK_STALL_POLLS - 1 },
      { decoded: 10, received: 500 },
    );
    expect(arriving.stalled).toBe(true);
    expect(arriving.mediaArriving).toBe(true);

    const silent = nextPlaybackStallState(
      { decoded: 10, received: 100, stalledPolls: PLAYBACK_STALL_POLLS - 1 },
      { decoded: 10, received: 100 },
    );
    expect(silent.stalled).toBe(true);
    expect(silent.mediaArriving).toBe(false);
  });

  test("the first sample only establishes a baseline", () => {
    expect(nextPlaybackStallState(initialPlaybackStallState, { decoded: 7, received: 1 }).stalled)
      .toBe(false);
  });
});

