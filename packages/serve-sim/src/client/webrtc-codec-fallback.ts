export type WebRtcCodec = "vp8" | "vp9" | "h264";

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
