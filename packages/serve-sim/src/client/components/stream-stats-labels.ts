import type { EncoderIdentity, SenderStreamStats } from "../../webrtc-sender-stats";

/**
 * The encoder's own view. None of this is visible to a receive-only browser.
 *
 * `paravirtualized:` marks a guest reaching the host's hardware encoder. A session with no
 * encoder id is not on H.264, so it falls back to naming its codec.
 */
export function encoderLabel(encoder: EncoderIdentity): string {
  const kind = encoder.hardware === true ? "hardware" : encoder.hardware === false ? "CPU" : "?";
  const id = encoder.id ?? "";
  if (!id) return encoder.codec ? `${encoder.codec.toLowerCase()} (${kind})` : kind;
  const tail = id.split(".").pop() ?? id;
  return `${id.startsWith("paravirtualized:") ? `paravirt ${tail}` : tail} (${kind})`;
}

/// `bandwidth` is the bitrate budget, not packet loss, so this never blames the network.
const DOWNSCALE_CAUSE: Record<string, string> = { cpu: "encoder", bandwidth: "bitrate" };

/** Why the picture is smaller than the size that was picked. */
export function describeDownscale(
  selectedMaxDimension: number,
  sender: Pick<SenderStreamStats, "width" | "height" | "qualityLimitationReason">,
): string | null {
  const longEdge = Math.max(sender.width ?? 0, sender.height ?? 0);
  if (selectedMaxDimension <= 0 || longEdge <= 0 || longEdge >= selectedMaxDimension) return null;
  const reason = sender.qualityLimitationReason;
  const cause = reason && reason !== "none" ? DOWNSCALE_CAUSE[reason] ?? reason : null;
  return `${longEdge} of ${selectedMaxDimension}${cause ? ` (${cause})` : ""}`;
}
