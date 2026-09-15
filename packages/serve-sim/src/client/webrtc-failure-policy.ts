export type WebRtcFailureEvent =
  | "first-frame-timeout"
  | "connection-failed"
  | "signaling-failed";

/// "wait" means the watchdog fired early: media is arriving, so re-arm rather than act.
export type WebRtcFailureDisposition = "codec" | "transport" | "wait";

export interface WebRtcMediaProgress {
  /// True when inbound RTP is advancing (framesReceived or bytesReceived growing).
  mediaArriving: boolean;
}

/// A first-frame timeout only indicts the codec when nothing is arriving at all.
///
/// The watchdog is cleared by `requestVideoFrameCallback`, i.e. by the browser *painting*.
/// A large first keyframe can arrive well inside the connection yet paint after the
/// deadline: measured on a Tart guest at 1206x2622, hardware H.264 was streaming correctly
/// and still got declared a codec failure, which permanently downgraded the session to
/// software VP8 (~63% of a vCPU versus ~27% for the hardware path). If RTP is flowing the
/// codec is demonstrably fine, so keep waiting instead of walking the fallback ladder.
export function webRtcFailureDisposition(
  event: WebRtcFailureEvent,
  connectionState: RTCPeerConnectionState,
  progress: WebRtcMediaProgress = { mediaArriving: false },
): WebRtcFailureDisposition {
  if (event !== "first-frame-timeout" || connectionState !== "connected") return "transport";
  return progress.mediaArriving ? "wait" : "codec";
}
