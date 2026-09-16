import { useCallback, useEffect, useRef, useState } from "react";
import type { WebRtcCodec, WebRtcStreamFailure } from "../webrtc-codec-fallback";
import {
  initialPlaybackStallState,
  nextPlaybackStallState,
  PLAYBACK_STALL_POLL_MS,
  webRtcFailureDisposition,
} from "../webrtc-failure-policy";
import { WEBRTC_ICE_TRANSPORT_POLICY, type IceServer } from "../webrtc-ice";
import { raiseH264OfferLevel } from "../webrtc-sdp-level";
import {
  closeWebRtcSession,
  postWebRtcOffer,
  WebRtcSignalingBusyError,
  WebRtcSignalingTimeoutError,
} from "../webrtc-negotiation";

const DEFAULT_ICE_SERVERS: IceServer[] = [
  { urls: ["stun:stun.l.google.com:19302"] },
  { urls: ["stun:stun1.l.google.com:19302"] },
];
const ICE_GATHERING_TIMEOUT_MS = 3_000;
// Native signaling has its own 10s deadline. Each accepted HTTP attempt gets a
// fresh browser deadline; time spent retrying 409s cannot consume it.
const SIGNALING_REQUEST_TIMEOUT_MS = 20_000;
const FIRST_FRAME_TIMEOUT_MS = 4_000;
interface InboundVideo {
  id: string;
  framesReceived: number;
  framesDecoded: number | null;
}

/// The inbound report for the stream being played.
///
/// A connection can carry several video reports — simulcast, or a retained one for an SSRC
/// that has gone away — so taking whichever the iterator yields last can judge a stream
/// nobody is watching. Prefer the one already being followed, else the liveliest.
async function readInboundVideo(
  pc: RTCPeerConnection | null,
  preferredId: string | null,
): Promise<InboundVideo | null> {
  if (!pc) return null;
  try {
    const reports: InboundVideo[] = [];
    (await pc.getStats()).forEach((entry) => {
      if (entry.type !== "inbound-rtp") return;
      const video = entry as RTCInboundRtpStreamStats & {
        framesReceived?: number;
        framesDecoded?: number;
      };
      if (video.kind !== "video") return;
      reports.push({
        id: video.id,
        framesReceived: video.framesReceived ?? 0,
        // Kept nullable: not every browser reports it, and absent is not zero.
        framesDecoded: typeof video.framesDecoded === "number" ? video.framesDecoded : null,
      });
    });
    if (reports.length === 0) return null;
    return reports.find((r) => r.id === preferredId)
      ?? reports.reduce((a, b) => (b.framesReceived > a.framesReceived ? b : a));
  } catch {
    return null;
  }
}

const BUSY_RETRY_INTERVAL_MS = 500;
// Native serializes offer setup. Retry beyond its 10s orphan deadline so one
// stalled negotiation cannot prevent another viewer from joining.
const BUSY_RETRY_COUNT = 30;
const TRANSPORT_RETRY_BASE_MS = 500;
const TRANSPORT_RETRY_MAX_MS = 5_000;

function createSessionId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function useWebRtcStream({
  offerUrl,
  closeUrl,
  enabled,
  codec = "h264",
  iceServers,
}: {
  offerUrl: string;
  closeUrl: string;
  enabled: boolean;
  codec?: WebRtcCodec;
  iceServers?: IceServer[];
}) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [failure, setFailure] = useState<WebRtcStreamFailure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const firstFrameTimeoutRef = useRef<number | undefined>(undefined);
  const firstFrameDecodedRef = useRef(false);
  const transportRetryAttemptRef = useRef(0);

  const markFrameDecoded = useCallback(() => {
    firstFrameDecodedRef.current = true;
    transportRetryAttemptRef.current = 0;
    if (firstFrameTimeoutRef.current !== undefined) {
      window.clearTimeout(firstFrameTimeoutRef.current);
      firstFrameTimeoutRef.current = undefined;
    }
    setFailure(null);
    setError(null);
  }, []);

  useEffect(() => {
    transportRetryAttemptRef.current = 0;
  }, [enabled, offerUrl, closeUrl, codec, iceServers]);

  useEffect(() => {
    if (!enabled || !offerUrl) return;
    setFailure(null);
    if (typeof RTCPeerConnection === "undefined" || typeof RTCRtpReceiver === "undefined") {
      setStream(null);
      setSessionId(null);
      setError("WebRTC is not supported by this browser.");
      setFailure({ sessionId: createSessionId(), kind: "permanent" });
      return;
    }

    let stopped = false;
    let pc: RTCPeerConnection | null = null;
    let retryTimer: number | undefined;
    let closePromise: Promise<void> | null = null;
    let failing = false;
    const lifecycleController = new AbortController();
    const sessionId = createSessionId();
    const servers = iceServers?.length ? iceServers : DEFAULT_ICE_SERVERS;
    setSessionId(sessionId);
    setStream(null);
    setFailure(null);
    setError(null);
    firstFrameDecodedRef.current = false;
    if (firstFrameTimeoutRef.current !== undefined) {
      window.clearTimeout(firstFrameTimeoutRef.current);
      firstFrameTimeoutRef.current = undefined;
    }

    const closeRemoteSession = (keepalive = false): Promise<void> => {
      if (closePromise) return closePromise;
      closePromise = closeWebRtcSession({
        url: closeUrl,
        sessionId,
        keepalive,
      });
      return closePromise;
    };
    const releaseOnPageHide = () => void closeRemoteSession(true);
    window.addEventListener("pagehide", releaseOnPageHide);
    window.addEventListener("beforeunload", releaseOnPageHide);

    // The first-frame watchdog stops once the stream paints. Past that a decoder can still
    // give up — typically on a frame larger than it handles, once the resolution moves up —
    // leaving the session connected, receiving, and decoding nothing.
    let stallState = initialPlaybackStallState;
    let inboundId: string | null = null;
    let statsInFlight = false;
    const playable = () =>
      !stopped && !failing && pc?.connectionState === "connected"
      && firstFrameDecodedRef.current && document.visibilityState === "visible";
    const stallTimer = window.setInterval(() => {
      // Browsers may stop decoding a hidden tab, which is indistinguishable from a dead one.
      if (!playable()) {
        stallState = initialPlaybackStallState;
        return;
      }
      // One read at a time: several slow reads resolving together would otherwise count one
      // measurement as several consecutive stalled polls.
      if (statsInFlight) return;
      statsInFlight = true;
      void readInboundVideo(pc, inboundId).finally(() => {
        statsInFlight = false;
      }).then((inbound) => {
        // Re-checked after the read, not before it: the tab can hide or the connection drop
        // while it is in flight, and a result from before that must not be acted on.
        if (!playable() || !inbound || !pc) return;
        if (inbound.id !== inboundId) {
          inboundId = inbound.id;
          stallState = initialPlaybackStallState;
        }
        const next = nextPlaybackStallState(stallState, {
          decoded: inbound.framesDecoded,
          received: inbound.framesReceived,
        });
        stallState = next.stalled ? initialPlaybackStallState : next.state;
        if (!next.stalled) return;
        const disposition = webRtcFailureDisposition("playback-stall", pc.connectionState, {
          mediaArriving: next.mediaArriving,
        });
        if (disposition === "codec") failCodec();
        else if (disposition === "transport") retryTransport("WebRTC playback stalled.");
      });
    }, PLAYBACK_STALL_POLL_MS);

    const closePeer = () => {
      setStream(null);
      pc?.close();
      // Readers of `peerConnection` would otherwise keep polling a closed connection for the whole
      // retry backoff, and report its last values as if the stream were still live.
      setPeerConnection(null);
    };

    const failPermanently = (message: string) => {
      if (stopped || failing) return;
      failing = true;
      setError(message);
      setFailure({ sessionId, kind: "permanent" });
      closePeer();
      void closeRemoteSession();
    };

    const failCodec = () => {
      if (stopped || failing) return;
      failing = true;
      closePeer();
      void closeRemoteSession().finally(() => {
        if (!stopped) setFailure({ sessionId, kind: "codec", codec });
      });
    };

    const retryTransport = (message: string) => {
      if (stopped || failing) return;
      failing = true;
      setFailure(null);
      const attempt = transportRetryAttemptRef.current++;
      const delay = Math.min(
        TRANSPORT_RETRY_BASE_MS * 2 ** Math.min(attempt, 4),
        TRANSPORT_RETRY_MAX_MS,
      );
      setError(`${message} Retrying...`);
      closePeer();
      void closeRemoteSession().finally(() => {
        if (stopped) return;
        retryTimer = window.setTimeout(() => {
          if (!stopped) setRetryGeneration((generation) => generation + 1);
        }, delay);
      });
    };

    const waitForIce = (connection: RTCPeerConnection) =>
      new Promise<void>((resolve) => {
        if (connection.iceGatheringState === "complete") {
          resolve();
          return;
        }
        let timeout: number | undefined;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          connection.removeEventListener("icegatheringstatechange", onState);
          if (timeout !== undefined) window.clearTimeout(timeout);
          resolve();
        };
        const onState = () => {
          if (connection.iceGatheringState === "complete") finish();
        };
        connection.addEventListener("icegatheringstatechange", onState);
        timeout = window.setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
      });

    void (async () => {
      try {
        pc = new RTCPeerConnection({
          iceServers: servers,
          iceTransportPolicy: WEBRTC_ICE_TRANSPORT_POLICY,
        });

        setPeerConnection(pc);

        const videoTransceiver = pc.addTransceiver("video", { direction: "recvonly" });
        const videoCapabilities = RTCRtpReceiver.getCapabilities("video");
        const preferredMimeType = codec === "h264"
          ? "video/H264"
          : codec === "vp9"
            ? "video/VP9"
            : "video/VP8";
        if (videoCapabilities?.codecs.length && "setCodecPreferences" in videoTransceiver) {
          const normalizedPreferredMimeType = preferredMimeType.toLowerCase();
          videoTransceiver.setCodecPreferences([
            ...videoCapabilities.codecs.filter((candidate) =>
              candidate.mimeType.toLowerCase() === normalizedPreferredMimeType
            ),
            ...videoCapabilities.codecs.filter((candidate) =>
              candidate.mimeType.toLowerCase() !== normalizedPreferredMimeType
            ),
          ]);
        }

        pc.ontrack = (event) => {
          if (stopped) return;
          firstFrameDecodedRef.current = false;
          event.track.onended = () => retryTransport("WebRTC video track ended.");
          setStream(event.streams[0] ?? new MediaStream([event.track]));
          if (firstFrameTimeoutRef.current !== undefined) {
            window.clearTimeout(firstFrameTimeoutRef.current);
          }
          // One extra window when RTP is arriving, so a slow first paint is not mistaken
          // for a broken codec. Bounded: an undecodable stream still falls back.
          let graceUsed = false;
          const armFirstFrameWatchdog = () => {
            firstFrameTimeoutRef.current = window.setTimeout(() => {
              firstFrameTimeoutRef.current = undefined;
              if (stopped || firstFrameDecodedRef.current) return;
              const state = pc?.connectionState ?? "closed";
              void readInboundVideo(pc, null).then((inbound) => {
                if (stopped || firstFrameDecodedRef.current) return;
                const mediaArriving = (inbound?.framesReceived ?? 0) > 0;
                const disposition = webRtcFailureDisposition("first-frame-timeout", state, {
                  mediaArriving,
                });
                if (disposition === "wait" && !graceUsed) {
                  graceUsed = true;
                  armFirstFrameWatchdog();
                } else if (disposition === "transport") {
                  retryTransport("WebRTC did not establish a video path.");
                } else {
                  failCodec();
                }
              });
            }, FIRST_FRAME_TIMEOUT_MS);
          };
          armFirstFrameWatchdog();
        };
        pc.onconnectionstatechange = () => {
          if (stopped || !pc || pc.connectionState !== "failed") return;
          if (webRtcFailureDisposition("connection-failed", pc.connectionState) === "transport") {
            retryTransport("WebRTC connection failed.");
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIce(pc);
        const local = pc.localDescription;
        if (!local) throw new Error("WebRTC offer was not created");
        // Only what the encoder reads is rewritten; our own description stays as the
        // browser built it. See raiseH264OfferLevel.
        const offerSdp = codec === "h264" ? raiseH264OfferLevel(local.sdp) : local.sdp;
        const response = await postWebRtcOffer({
          url: offerUrl,
          signal: lifecycleController.signal,
          requestTimeoutMs: SIGNALING_REQUEST_TIMEOUT_MS,
          busyRetryIntervalMs: BUSY_RETRY_INTERVAL_MS,
          busyRetryCount: BUSY_RETRY_COUNT,
          body: JSON.stringify({
            type: local.type,
            sdp: offerSdp,
            sessionId,
            codec,
            iceServers: servers,
          }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          failPermanently(`WebRTC offer failed: HTTP ${response.status}`);
          return;
        }
        const answer = await response.json() as RTCSessionDescriptionInit;
        if (stopped) {
          await closeRemoteSession(true);
          return;
        }
        try {
          await pc.setRemoteDescription(answer);
        } catch {
          failPermanently("WebRTC returned an invalid session description.");
        }
      } catch (caught) {
        if (stopped || lifecycleController.signal.aborted) return;
        if (caught instanceof WebRtcSignalingBusyError) {
          failPermanently(caught.message);
          return;
        }
        const message = caught instanceof WebRtcSignalingTimeoutError
          ? "WebRTC signaling timed out."
          : "WebRTC signaling failed.";
        if (webRtcFailureDisposition("signaling-failed", pc?.connectionState ?? "closed") === "transport") {
          retryTransport(message);
        }
      }
    })();

    return () => {
      stopped = true;
      window.clearInterval(stallTimer);
      window.removeEventListener("pagehide", releaseOnPageHide);
      window.removeEventListener("beforeunload", releaseOnPageHide);
      lifecycleController.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (firstFrameTimeoutRef.current !== undefined) {
        window.clearTimeout(firstFrameTimeoutRef.current);
        firstFrameTimeoutRef.current = undefined;
      }
      void closeRemoteSession(true);
      setStream(null);
      setPeerConnection(null);
      setSessionId(null);
      pc?.close();
    };
  }, [enabled, offerUrl, closeUrl, codec, iceServers, retryGeneration]);

  return { stream, failure, error, markFrameDecoded, peerConnection, sessionId };
}
