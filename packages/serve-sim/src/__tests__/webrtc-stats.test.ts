import { describe, expect, test } from "bun:test";

import { describeStreamStats, readStreamStats } from "../client/utils/webrtc-stats";

/** RTCStatsReport is a Map with a typed forEach; a Map is a faithful stand-in. */
function report(entries: Record<string, unknown>[]): RTCStatsReport {
  return new Map(entries.map((entry) => [entry.id as string, entry])) as unknown as RTCStatsReport;
}

const INBOUND = {
  id: "in",
  type: "inbound-rtp",
  kind: "video",
  codecId: "c",
  framesDecoded: 100,
  framesDropped: 2,
  freezeCount: 1,
  totalFreezesDuration: 0.5,
  bytesReceived: 500_000,
  packetsReceived: 900,
  packetsLost: 100,
  framesPerSecond: 30,
  frameWidth: 1280,
  frameHeight: 720,
  jitter: 0.012,
  jitterBufferDelay: 4,
  jitterBufferEmittedCount: 100,
};

describe("readStreamStats", () => {
  test("pulls the video inbound numbers and converts seconds to milliseconds", () => {
    const sample = readStreamStats(report([{ id: "c", type: "codec", mimeType: "video/VP8" }, INBOUND]), 1_000);

    expect(sample.framesDecoded).toBe(100);
    expect(sample.codec).toBe("video/VP8");
    expect(sample.jitterMs).toBeCloseTo(12, 5);
    expect(sample.freezeMs).toBeCloseTo(500, 5);
    // Cumulative delay over emitted frames, not the raw total.
    expect(sample.jitterBufferMs).toBeCloseTo(40, 5);
  });

  test("ignores audio, so an audio track cannot overwrite the video numbers", () => {
    const sample = readStreamStats(
      report([INBOUND, { id: "a", type: "inbound-rtp", kind: "audio", framesDecoded: 9_999 }]),
      1_000,
    );

    expect(sample.framesDecoded).toBe(100);
  });

  test("names a TURN-relayed path, which is the expensive one", () => {
    const sample = readStreamStats(
      report([
        INBOUND,
        { id: "p", type: "candidate-pair", selected: true, localCandidateId: "l", remoteCandidateId: "r",
          currentRoundTripTime: 0.08, availableIncomingBitrate: 2_400_000 },
        { id: "l", type: "local-candidate", candidateType: "relay" },
        { id: "r", type: "remote-candidate", candidateType: "host" },
      ]),
      1_000,
    );

    expect(sample.path).toBe("relay");
    expect(sample.roundTripMs).toBeCloseTo(80, 5);
    expect(sample.availableIncomingKbps).toBeCloseTo(2_400, 5);
  });

  test("calls a host-to-srflx pair direct", () => {
    const sample = readStreamStats(
      report([
        INBOUND,
        { id: "p", type: "candidate-pair", selected: true, localCandidateId: "l", remoteCandidateId: "r" },
        { id: "l", type: "local-candidate", candidateType: "host" },
        { id: "r", type: "remote-candidate", candidateType: "srflx" },
      ]),
      1_000,
    );

    expect(sample.path).toBe("direct");
  });

  test("says unknown rather than guessing when the candidates are missing", () => {
    const sample = readStreamStats(
      report([INBOUND, { id: "p", type: "candidate-pair", selected: true, localCandidateId: "gone" }]),
      1_000,
    );

    expect(sample.path).toBe("unknown");
  });

  test("survives a report with nothing in it", () => {
    const sample = readStreamStats(report([]), 1_000);

    expect(sample.framesDecoded).toBe(0);
    expect(sample.jitterMs).toBeNull();
    expect(sample.path).toBe("unknown");
  });
});

describe("describeStreamStats", () => {
  test("reports no rates from a single sample, rather than zero", () => {
    const stats = describeStreamStats(null, readStreamStats(report([INBOUND]), 1_000));

    expect(stats.fps).toBeNull();
    expect(stats.kbps).toBeNull();
  });

  test("derives fps and kbps across the window", () => {
    const first = readStreamStats(report([INBOUND]), 1_000);
    const second = readStreamStats(
      report([{ ...INBOUND, framesDecoded: 160, bytesReceived: 750_000 }]),
      3_000,
    );

    const stats = describeStreamStats(first, second);

    expect(stats.fps).toBeCloseTo(30, 5);
    expect(stats.kbps).toBeCloseTo(1_000, 5);
  });

  test("counts loss over the window, not the lifetime", () => {
    const first = readStreamStats(report([INBOUND]), 1_000);
    const second = readStreamStats(
      report([{ ...INBOUND, packetsReceived: 1_890, packetsLost: 110 }]),
      2_000,
    );

    // 990 arrived and 10 were lost in this window, so 1% — not the 10% lifetime figure.
    expect(describeStreamStats(first, second).lossRatio).toBeCloseTo(0.01, 5);
  });

  test("does not report negative rates when counters reset on reconnect", () => {
    const first = readStreamStats(report([INBOUND]), 1_000);
    const second = readStreamStats(report([{ ...INBOUND, framesDecoded: 5, bytesReceived: 10 }]), 2_000);

    const stats = describeStreamStats(first, second);

    expect(stats.fps).toBe(0);
    expect(stats.kbps).toBe(0);
  });
});
