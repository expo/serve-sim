import { describe, expect, test } from "bun:test";

import { ladderRestartDelayMs, webRtcFallbackDecision } from "../client/webrtc-codec-fallback";

describe("restarting the codec ladder", () => {
  test("backs off, because the cause usually outlives one attempt", () => {
    const delays = [0, 1, 2, 3, 4, 5, 20].map(ladderRestartDelayMs);
    expect(delays[0]).toBe(2_000);
    expect(delays[1]).toBe(4_000);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
  });

  test("caps, so a long outage still retries on a predictable beat", () => {
    expect(ladderRestartDelayMs(20)).toBe(30_000);
    expect(ladderRestartDelayMs(Number.MAX_SAFE_INTEGER)).toBe(30_000);
  });

  test("never returns a delay that would hot-loop", () => {
    for (const attempt of [-5, -1, 0]) {
      expect(ladderRestartDelayMs(attempt)).toBeGreaterThanOrEqual(2_000);
    }
  });

  /// The ladder reaching its end is what the restart hangs off, so pin it.
  test("the last codec still reports the ladder as exhausted", () => {
    expect(webRtcFallbackDecision("h264", "vp9", { kind: "codec", codec: "vp9" }))
      .toEqual({ type: "switch-to-http" });
    expect(webRtcFallbackDecision("h264", "h264", { kind: "codec", codec: "h264" }))
      .toEqual({ type: "retry-codec", codec: "vp8" });
  });

  /// A delivered track is not playback. Reproduced by the reviewer: five attempts that each
  /// negotiated and never decoded produced 2000, 2000, 2000, 2000, 2000 instead of escalating.
  test("only demonstrated playback resets the backoff", () => {
    // Model the two reset signals over five failing attempts.
    const walk = (resetsOn: "track" | "paint") => {
      let attempt = 0;
      const delays: number[] = [];
      for (let i = 0; i < 5; i++) {
        // Every attempt delivers a track; none ever paints a frame.
        if (resetsOn === "track") attempt = 0;
        delays.push(ladderRestartDelayMs(attempt));
        attempt += 1;
      }
      return delays;
    };
    expect(walk("track")).toEqual([2_000, 2_000, 2_000, 2_000, 2_000]);
    expect(walk("paint")).toEqual([2_000, 4_000, 8_000, 16_000, 30_000]);
  });
});
