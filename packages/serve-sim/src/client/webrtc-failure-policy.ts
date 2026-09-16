export type WebRtcFailureEvent =
  | "first-frame-timeout"
  | "playback-stall"
  | "connection-failed"
  | "signaling-failed";

/// "wait" means the deadline passed but media is arriving, so the caller should re-arm.
export type WebRtcFailureDisposition = "codec" | "transport" | "wait";

export interface WebRtcMediaProgress {
  mediaArriving: boolean;
  /// Whether the sender reports encoding frames, or null when it could not be asked.
  ///
  /// A dead media path and a dead encoder look identical from here: connected, nothing
  /// arriving. Only the sender can tell them apart, and blaming the codec for a transport
  /// fault costs a rung of the ladder that a codec change cannot repair.
  senderEncoding?: boolean | null;
}

/// Before the first frame, arriving media means be patient. After it, whole frames that
/// arrive and stop being decoded mean the decoder gave up, and waiting cannot fix that.
///
/// "Arriving" counts assembled frames, not bytes. Under packet loss the bytes keep coming
/// while no frame ever completes; that is the transport's fault and changing codec cannot
/// repair it, so it must not spend one of the ladder's attempts.
export function webRtcFailureDisposition(
  event: WebRtcFailureEvent,
  connectionState: RTCPeerConnectionState,
  progress: WebRtcMediaProgress = { mediaArriving: false },
): WebRtcFailureDisposition {
  if (connectionState !== "connected") return "transport";
  if (event === "first-frame-timeout") {
    if (progress.mediaArriving) return "wait";
    // Unknown stays "codec": that is the long-standing behaviour, and the ladder is what
    // catches an encoder producing nothing. Only a sender we positively know is encoding
    // redirects the blame.
    return progress.senderEncoding === true ? "transport" : "codec";
  }
  if (event === "playback-stall") return progress.mediaArriving ? "codec" : "transport";
  return "transport";
}

export const PLAYBACK_STALL_POLL_MS = 2_000;
/// Counted in polls, never in wall-clock: a hidden tab's interval is throttled or suspended
/// outright, so elapsed time there says nothing about whether decoding stopped.
export const PLAYBACK_STALL_POLLS = 4;

export interface PlaybackProgress {
  /// Null when the browser does not report the counter, which is not the same as zero.
  decoded: number | null;
  /// Whole frames assembled from RTP. Bytes are the wrong signal: packet loss keeps bytes
  /// climbing while no frame ever completes, which is the transport's fault, not the codec's.
  received: number;
}

export interface PlaybackStallState {
  decoded: number | null;
  received: number;
  stalledPolls: number;
}

export const initialPlaybackStallState: PlaybackStallState = {
  decoded: null,
  received: 0,
  stalledPolls: 0,
};

/// Whether decoding has stopped while media keeps arriving.
///
/// Only a counter that stands still across consecutive polls counts. Anything ambiguous —
/// no counter, a first sample, a counter that went backwards because the report was
/// replaced — restarts the run rather than accusing the decoder.
export function nextPlaybackStallState(
  state: PlaybackStallState,
  progress: PlaybackProgress,
): { state: PlaybackStallState; stalled: boolean; mediaArriving: boolean } {
  const mediaArriving = progress.received > state.received;
  const settled = (stalledPolls: number) => ({
    state: { decoded: progress.decoded, received: progress.received, stalledPolls },
    stalled: false,
    mediaArriving,
  });
  if (progress.decoded === null || state.decoded === null) return settled(0);
  if (progress.decoded !== state.decoded) return settled(0);
  const stalledPolls = state.stalledPolls + 1;
  return {
    state: { decoded: progress.decoded, received: progress.received, stalledPolls },
    stalled: stalledPolls >= PLAYBACK_STALL_POLLS,
    mediaArriving,
  };
}

