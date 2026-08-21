/**
 * Reduce an `RTCStatsReport` to the numbers that explain a laggy stream.
 *
 * Kept pure and separate from the polling so the field selection and the rate maths are testable
 * without a browser or a peer connection.
 */

export interface StreamStatsSample {
  atMs: number;
  framesDecoded: number;
  framesDropped: number;
  freezeCount: number;
  freezeMs: number;
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
  jitterMs: number | null;
  jitterBufferMs: number | null;
  reportedFps: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  roundTripMs: number | null;
  availableIncomingKbps: number | null;
  /** `relay` means media is going through TURN, which costs latency and throughput. */
  path: "direct" | "relay" | "unknown";
}

export interface StreamStats extends StreamStatsSample {
  /** Frames actually painted per second, measured across the sample window. */
  fps: number | null;
  kbps: number | null;
  /** Share of frames lost in the window, 0-1. Loss is per-window, not lifetime. */
  lossRatio: number | null;
  droppedInWindow: number;
  freezesInWindow: number;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function maybeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Pull one sample out of a report. `now` is passed in so tests are not clock-dependent. */
export function readStreamStats(report: RTCStatsReport, now: number): StreamStatsSample {
  const sample: StreamStatsSample = {
    atMs: now,
    framesDecoded: 0,
    framesDropped: 0,
    freezeCount: 0,
    freezeMs: 0,
    bytesReceived: 0,
    packetsReceived: 0,
    packetsLost: 0,
    jitterMs: null,
    jitterBufferMs: null,
    reportedFps: null,
    width: null,
    height: null,
    codec: null,
    roundTripMs: null,
    availableIncomingKbps: null,
    path: "unknown",
  };

  const codecsById = new Map<string, string>();
  let selectedPair: Record<string, unknown> | null = null;
  const candidatesById = new Map<string, Record<string, unknown>>();

  report.forEach((entry: Record<string, unknown>) => {
    switch (entry.type) {
      case "codec":
        if (typeof entry.id === "string" && typeof entry.mimeType === "string") {
          codecsById.set(entry.id, entry.mimeType);
        }
        break;
      case "inbound-rtp": {
        if (entry.kind !== "video") break;
        sample.framesDecoded = number(entry.framesDecoded);
        sample.framesDropped = number(entry.framesDropped);
        sample.freezeCount = number(entry.freezeCount);
        sample.freezeMs = number(entry.totalFreezesDuration) * 1000;
        sample.bytesReceived = number(entry.bytesReceived);
        sample.packetsReceived = number(entry.packetsReceived);
        sample.packetsLost = number(entry.packetsLost);
        sample.reportedFps = maybeNumber(entry.framesPerSecond);
        sample.width = maybeNumber(entry.frameWidth);
        sample.height = maybeNumber(entry.frameHeight);
        const jitter = maybeNumber(entry.jitter);
        sample.jitterMs = jitter === null ? null : jitter * 1000;
        // jitterBufferDelay is cumulative seconds; per-frame delay needs the emitted count.
        const delay = maybeNumber(entry.jitterBufferDelay);
        const emitted = maybeNumber(entry.jitterBufferEmittedCount);
        sample.jitterBufferMs = delay !== null && emitted !== null && emitted > 0
          ? (delay / emitted) * 1000
          : null;
        if (typeof entry.codecId === "string") sample.codec = codecsById.get(entry.codecId) ?? null;
        break;
      }
      case "candidate-pair":
        if (entry.selected === true || entry.state === "succeeded") {
          if (selectedPair === null || entry.selected === true) selectedPair = entry;
        }
        break;
      case "local-candidate":
      case "remote-candidate":
        if (typeof entry.id === "string") candidatesById.set(entry.id, entry);
        break;
    }
  });

  if (selectedPair) {
    const pair: Record<string, unknown> = selectedPair;
    const rtt = maybeNumber(pair.currentRoundTripTime);
    sample.roundTripMs = rtt === null ? null : rtt * 1000;
    const incoming = maybeNumber(pair.availableIncomingBitrate);
    sample.availableIncomingKbps = incoming === null ? null : incoming / 1000;
    const ends = [pair.localCandidateId, pair.remoteCandidateId]
      .map((id) => (typeof id === "string" ? candidatesById.get(id) : undefined))
      .map((candidate) => (candidate?.candidateType as string | undefined) ?? null);
    if (ends.some((type) => type === null)) sample.path = "unknown";
    else sample.path = ends.includes("relay") ? "relay" : "direct";
  }

  // A codec entry can arrive without an inbound-rtp codecId on some browsers.
  if (sample.codec === null && codecsById.size === 1) {
    sample.codec = [...codecsById.values()][0] ?? null;
  }
  return sample;
}

/** Turn two samples into displayable rates. Returns null rates when the window is unusable. */
export function describeStreamStats(
  previous: StreamStatsSample | null,
  current: StreamStatsSample,
): StreamStats {
  const elapsedMs = previous === null ? 0 : current.atMs - previous.atMs;
  if (previous === null || elapsedMs <= 0) {
    return {
      ...current,
      fps: null,
      kbps: null,
      lossRatio: null,
      droppedInWindow: 0,
      freezesInWindow: 0,
    };
  }

  const seconds = elapsedMs / 1000;
  const decoded = current.framesDecoded - previous.framesDecoded;
  const packets = current.packetsReceived - previous.packetsReceived;
  const lost = current.packetsLost - previous.packetsLost;
  return {
    ...current,
    fps: Math.max(0, decoded) / seconds,
    kbps: (Math.max(0, current.bytesReceived - previous.bytesReceived) * 8) / 1000 / seconds,
    lossRatio: packets + lost > 0 ? Math.max(0, lost) / (packets + lost) : null,
    droppedInWindow: Math.max(0, current.framesDropped - previous.framesDropped),
    freezesInWindow: Math.max(0, current.freezeCount - previous.freezeCount),
  };
}
