import { describe, expect, test } from "bun:test";
import {
  initialPlaybackStallState,
  nextPlaybackStallState,
  offerFailureIsTransient,
  PLAYBACK_STALL_POLLS,
  PLAYBACK_STALL_POLL_MS,
  selectInboundReport,
  webRtcFailureDisposition,
  type PlaybackProgress,
  type PlaybackStallState,
  playbackStallAction,
  STALL_RECONNECT_TTL_MS,
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

describe("who to blame when nothing arrives before the first frame", () => {
  const timeout = (senderEncoding: boolean | null | undefined) =>
    webRtcFailureDisposition("first-frame-timeout", "connected", {
      mediaArriving: false,
      senderEncoding,
    });

  test("blames the transport when the sender is encoding and we receive nothing", () => {
    expect(timeout(true)).toBe("transport");
  });

  test("blames the codec when the sender encoded nothing at all", () => {
    expect(timeout(false)).toBe("codec");
  });

  test("blames the codec when the sender could not be asked", () => {
    expect(timeout(null)).toBe("codec");
    expect(timeout(undefined)).toBe("codec");
  });

  test("arriving media still outranks the sender's opinion", () => {
    expect(webRtcFailureDisposition("first-frame-timeout", "connected", {
      mediaArriving: true,
      senderEncoding: false,
    })).toBe("wait");
  });

  test("a connection that is not up is the transport's problem regardless", () => {
    expect(webRtcFailureDisposition("first-frame-timeout", "failed", {
      mediaArriving: false,
      senderEncoding: false,
    })).toBe("transport");
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

  /// The budget itself, not just the boundary: every run above is sized off the constant, so
  /// retiming the poll would otherwise move the tests with it and go unnoticed.
  test("a stall is called after eight seconds of frozen decode", () => {
    expect(PLAYBACK_STALL_POLLS * PLAYBACK_STALL_POLL_MS).toBe(8_000);
  });

  test("reports a stall only after consecutive polls with no decoding", () => {
    const stalls = run(frozen(PLAYBACK_STALL_POLLS + 1));
    expect(stalls.slice(0, PLAYBACK_STALL_POLLS)).not.toContain(true);
    expect(stalls[PLAYBACK_STALL_POLLS]).toBe(true);
  });

  test("a long gap between polls is not itself a stall", () => {
    expect(run([{ decoded: 5, received: 10 }, { decoded: 9, received: 99 }])).not.toContain(true);
  });

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

describe("choosing which inbound report to judge", () => {
  const r = (id: string, framesReceived: number) => ({ id, framesReceived });

  test("follows the only report there is", () => {
    expect(selectInboundReport([r("a", 10)], null)?.id).toBe("a");
  });

  test("leaves a pinned report once it stops advancing and a sibling is ahead", () => {
    const reports = [r("old", 1_000), r("new", 2_030)];
    expect(selectInboundReport(reports, { id: "old", framesReceived: 1_000 })?.id).toBe("new");
  });

  test("follows a newly advancing stream even when its lifetime count is lower", () => {
    const previousReports = [r("old", 1_000), r("new", 12)];
    const reports = [r("old", 1_000), r("new", 13)];
    expect(selectInboundReport(reports, previousReports[0]!, previousReports)?.id).toBe("new");
  });

  test("keeps the pinned report while it is still advancing", () => {
    const reports = [r("old", 1_010), r("new", 2_030)];
    expect(selectInboundReport(reports, { id: "old", framesReceived: 1_000 })?.id).toBe("old");
  });

  test("does not flap to a stalled sibling that happens to be behind", () => {
    const reports = [r("a", 500), r("b", 100)];
    expect(selectInboundReport(reports, { id: "a", framesReceived: 500 })?.id).toBe("a");
  });

  test("re-selects when the pinned report disappears", () => {
    expect(selectInboundReport([r("b", 7)], { id: "gone", framesReceived: 99 })?.id).toBe("b");
  });

  test("says nothing when there is nothing to judge", () => {
    expect(selectInboundReport([], { id: "a", framesReceived: 1 })).toBeNull();
  });
});

describe("what a stall verdict does", () => {
  test("reconnects on the same codec before blaming it", () => {
    expect(playbackStallAction("codec", null)).toBe("retry-transport");
  });

  test("blames the codec once a stall survives the reconnect", () => {
    expect(playbackStallAction("codec", 0)).toBe("fail-codec");
    expect(playbackStallAction("codec", STALL_RECONNECT_TTL_MS - 1)).toBe("fail-codec");
  });

  test("an old reconnect no longer counts against the codec", () => {
    expect(playbackStallAction("codec", STALL_RECONNECT_TTL_MS)).toBe("retry-transport");
    expect(playbackStallAction("codec", 3 * 60 * 60 * 1000)).toBe("retry-transport");
  });

  test("always retries the transport, whatever the codec did", () => {
    expect(playbackStallAction("transport", null)).toBe("retry-transport");
    expect(playbackStallAction("transport", 0)).toBe("retry-transport");
  });

  test("does nothing when the verdict is to wait", () => {
    expect(playbackStallAction("wait", null)).toBe("none");
  });
});

describe("a rejected offer", () => {
  /// The reported case: the helper had restarted and the route returned before anyone looked.
  test("treats a 404 as worth another try", () => {
    expect(offerFailureIsTransient(404)).toBe(true);
  });

  test("retries the statuses that clear on their own", () => {
    for (const status of [404, 408, 425, 429, 500, 502, 503, 504]) {
      expect(offerFailureIsTransient(status)).toBe(true);
    }
  });

  /// Server-side statuses are all treated as worth retrying; only the client-side
  /// refusals are final, and those are the ones a retry would paper over.
  test("gives up on a request that will never be accepted", () => {
    for (const status of [400, 401, 403, 405, 410]) {
      expect(offerFailureIsTransient(status)).toBe(false);
    }
  });
});
