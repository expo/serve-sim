export type WebRtcFailureEvent =
  | "first-frame-timeout"
  | "playback-stall"
  | "connection-failed"
  | "signaling-failed";

/// "wait" means the deadline passed but media is arriving, so the caller should re-arm.
export type WebRtcFailureDisposition = "codec" | "transport" | "wait";

export interface WebRtcMediaProgress {
  mediaArriving: boolean;
}

/// Arriving RTP means opposite things before and after the first painted frame.
///
/// Before: the watchdog is cleared by the browser *painting*, which also waits on the video
/// element being attached. Received RTP is the narrower question, so when media is flowing,
/// keep waiting rather than downgrading a stream that is merely slow to appear.
///
/// After: the stream has already proved it decodes. RTP that keeps arriving while nothing
/// paints means the decoder stopped coping with what it is being sent — typically a frame
/// larger than it can handle, once the resolution moved up. Waiting cannot fix that.
export function webRtcFailureDisposition(
  event: WebRtcFailureEvent,
  connectionState: RTCPeerConnectionState,
  progress: WebRtcMediaProgress = { mediaArriving: false },
): WebRtcFailureDisposition {
  if (connectionState !== "connected") return "transport";
  if (event === "first-frame-timeout") return progress.mediaArriving ? "wait" : "codec";
  if (event === "playback-stall") return progress.mediaArriving ? "codec" : "transport";
  return "transport";
}

/// A painting stream that goes this long without a frame has stopped decoding. Generous on
/// purpose: capture holds a 5 fps idle floor, so this is ~40 missed frames, and a false
/// positive downgrades a working stream, which is the fault this watchdog exists to avoid.
export const PLAYBACK_STALL_TIMEOUT_MS = 8_000;

/// Whether a stalled-playback check is even meaningful yet.
///
/// `requestVideoFrameCallback` does not run while the tab is hidden, so a backgrounded tab
/// looks exactly like a decoder that died. Before the first paint the first-frame watchdog
/// owns the stream and this must stay out of its way.
export function shouldCheckPlaybackStall(
  { painted, msSincePaint, documentHidden }: {
    painted: boolean;
    msSincePaint: number;
    documentHidden: boolean;
  },
): boolean {
  if (!painted || documentHidden) return false;
  return msSincePaint >= PLAYBACK_STALL_TIMEOUT_MS;
}

