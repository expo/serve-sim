export type WebRtcFailureEvent =
  | "first-frame-timeout"
  | "playback-stall"
  | "connection-failed"
  | "signaling-failed";

/// "wait" means the deadline passed but media is arriving, so the caller should re-arm.
export type WebRtcFailureDisposition = "codec" | "transport" | "wait";

export interface WebRtcMediaProgress {
  mediaArriving: boolean;
  /// Null when the sender could not be asked; only it can tell a dead path from a dead encoder.
  senderEncoding?: boolean | null;
}

/// Before the first frame, arriving media means be patient. After it, frames that arrive and
/// stop being decoded mean the decoder gave up, and waiting cannot fix that.
export function webRtcFailureDisposition(
  event: WebRtcFailureEvent,
  connectionState: RTCPeerConnectionState,
  progress: WebRtcMediaProgress = { mediaArriving: false },
): WebRtcFailureDisposition {
  if (connectionState !== "connected") return "transport";
  if (event === "first-frame-timeout") {
    if (progress.mediaArriving) return "wait";
    // Unknown stays "codec": only a sender known to be encoding redirects the blame.
    return progress.senderEncoding === true ? "transport" : "codec";
  }
  if (event === "playback-stall") return progress.mediaArriving ? "codec" : "transport";
  return "transport";
}

/// How long a same-codec reconnect counts against the codec. Past this the next stall is a
/// separate incident, not the same one continuing, and earns its own reconnect.
export const STALL_RECONNECT_TTL_MS = 30_000;

/// The codec gets a reconnect before it is blamed, or one bad run of frames costs hardware
/// H.264 for the session. Elapsed time rather than a flag, so two unrelated stalls hours
/// apart do not add up to a demotion.
export function playbackStallAction(
  disposition: WebRtcFailureDisposition,
  msSinceCodecReconnect: number | null,
): "retry-transport" | "fail-codec" | "none" {
  if (disposition === "transport") return "retry-transport";
  if (disposition !== "codec") return "none";
  if (msSinceCodecReconnect === null) return "retry-transport";
  return msSinceCodecReconnect < STALL_RECONNECT_TTL_MS ? "fail-codec" : "retry-transport";
}

/// One read a second, shared with the stats panel so nothing polls `getStats` twice.
export const PLAYBACK_STALL_POLL_MS = 1_000;
/// Polls, not wall-clock: a hidden tab's interval is throttled, so elapsed time there says
/// nothing about whether decoding stopped. Eight of them is the same eight seconds as before.
export const PLAYBACK_STALL_POLLS = 8;

export interface PlaybackProgress {
  /// Null when the browser does not report the counter, which is not the same as zero.
  decoded: number | null;
  /// Whole frames assembled from RTP. Loss keeps bytes climbing while no frame completes, so
  /// bytes would read as healthy media.
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

/// Whether decoding stopped while media keeps arriving. Anything ambiguous restarts the run
/// rather than accusing the decoder.
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

export interface InboundReport {
  id: string;
  framesReceived: number;
}

/// Which inbound report to judge when a connection carries more than one. Following one by id
/// alone pins a report for an SSRC that has gone away, so a stalled pin yields to a live one.
export function selectInboundReport<T extends InboundReport>(
  reports: T[],
  previous: InboundReport | null,
  previousReports: readonly InboundReport[] = [],
): T | null {
  if (reports.length === 0) return null;
  const liveliest = reports.reduce((a, b) => (b.framesReceived > a.framesReceived ? b : a));
  if (!previous) return liveliest;
  const pinned = reports.find((r) => r.id === previous.id);
  if (!pinned) return liveliest;
  if (pinned.framesReceived > previous.framesReceived) return pinned;
  let advancingSibling: T | null = null;
  let largestIncrease = 0;
  for (const report of reports) {
    if (report.id === pinned.id) continue;
    const earlier = previousReports.find((r) => r.id === report.id);
    const increase = earlier ? report.framesReceived - earlier.framesReceived : 0;
    if (increase > largestIncrease) {
      advancingSibling = report;
      largestIncrease = increase;
    }
  }
  if (advancingSibling) return advancingSibling;
  return liveliest.framesReceived > pinned.framesReceived ? liveliest : pinned;
}
