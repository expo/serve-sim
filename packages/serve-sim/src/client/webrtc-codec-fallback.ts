import type { WebRtcStreamCodec } from "../state";

export type WebRtcCodec = WebRtcStreamCodec;

export type WebRtcFailureReason =
  | { kind: "permanent" }
  | { kind: "codec"; codec: WebRtcCodec };

export type WebRtcStreamFailure = WebRtcFailureReason & { sessionId: string };

export type WebRtcFallbackDecision =
  | { type: "retry-codec"; codec: WebRtcCodec }
  | { type: "switch-to-http" };

const FALLBACK_ATTEMPTS: Record<WebRtcCodec, readonly WebRtcCodec[]> = {
  h264: ["h264", "vp8", "vp9"],
  vp9: ["vp9", "vp8"],
  vp8: ["vp8"],
};

export function nextWebRtcFallbackCodec(
  requested: WebRtcCodec,
  current: WebRtcCodec,
): WebRtcCodec | null {
  const attempts = FALLBACK_ATTEMPTS[requested];
  const currentIndex = attempts.indexOf(current);
  if (currentIndex === -1) return attempts[0] ?? null;
  return attempts[currentIndex + 1] ?? null;
}

export function webRtcFallbackDecision(
  requested: WebRtcCodec,
  current: WebRtcCodec,
  failure: WebRtcFailureReason,
): WebRtcFallbackDecision | null {
  if (failure.kind === "permanent") return { type: "switch-to-http" };
  if (failure.codec !== current) return null;
  const nextCodec = nextWebRtcFallbackCodec(requested, current);
  return nextCodec && nextCodec !== current
    ? { type: "retry-codec", codec: nextCodec }
    : { type: "switch-to-http" };
}

const LADDER_RESTART_BASE_MS = 2_000;
const LADDER_RESTART_MAX_MS = 30_000;

/// How long to wait before starting the codec ladder again when there is nothing left to
/// fall back to.
///
/// Exhausting the ladder means every codec failed, which is far more often one cause
/// affecting all of them than three separate codec faults. Backing off and starting over
/// beats leaving the session dead, but it has to back off: the cause usually outlives one
/// attempt, and a locked session has no other transport to escape to.
export function ladderRestartDelayMs(attempt: number): number {
  const exponent = Math.min(Math.max(attempt, 0), 4);
  return Math.min(LADDER_RESTART_BASE_MS * 2 ** exponent, LADDER_RESTART_MAX_MS);
}

