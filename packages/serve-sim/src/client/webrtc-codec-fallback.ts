export type WebRtcCodec = "vp8" | "vp9" | "h264";

const FALLBACKS: Record<WebRtcCodec, WebRtcCodec[]> = {
  h264: ["vp8", "vp9"],
  vp9: ["vp8"],
  vp8: [],
};

export function nextWebRtcFallbackCodec(
  requested: WebRtcCodec,
  current: WebRtcCodec,
): WebRtcCodec | null {
  const attempts = [requested, ...FALLBACKS[requested]].filter((codec, index, all) =>
    all.indexOf(codec) === index
  );
  const currentIndex = attempts.indexOf(current);
  if (currentIndex === -1) return attempts[0] ?? null;
  return attempts[currentIndex + 1] ?? null;
}

export function negotiatedWebRtcCodecFromSdp(sdp: string): WebRtcCodec | null {
  const payloads: string[] = [];
  const codecByPayload = new Map<string, WebRtcCodec>();
  let inVideoSection = false;

  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("m=")) {
      inVideoSection = line.startsWith("m=video");
      if (inVideoSection) {
        payloads.splice(0, payloads.length, ...line.trim().split(/\s+/).slice(3));
      }
      continue;
    }
    if (!inVideoSection) continue;
    const match = /^a=rtpmap:(\d+)\s+([^/\s]+)\//i.exec(line);
    if (!match) continue;
    const payload = match[1];
    const codecName = match[2];
    if (!payload || !codecName) continue;
    const codec = normalizeWebRtcCodec(codecName);
    if (codec) codecByPayload.set(payload, codec);
  }

  for (const payload of payloads) {
    const codec = codecByPayload.get(payload);
    if (codec) return codec;
  }
  return null;
}

function normalizeWebRtcCodec(codec: string): WebRtcCodec | null {
  switch (codec.toLowerCase()) {
    case "h264":
      return "h264";
    case "vp8":
      return "vp8";
    case "vp9":
      return "vp9";
    default:
      return null;
  }
}
