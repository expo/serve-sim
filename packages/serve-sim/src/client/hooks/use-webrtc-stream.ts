import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WebRtcCodec, WebRtcStreamFailure } from "../webrtc-codec-fallback";
import { webRtcFailureDisposition } from "../webrtc-failure-policy";
import { WEBRTC_ICE_TRANSPORT_POLICY, type IceServer } from "../webrtc-ice";
import { dataChannelSendTarget } from "../webrtc-input-channel";
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
  const [inputChannelOpen, setInputChannelOpen] = useState(false);
  const inputChannelRef = useRef<RTCDataChannel | null>(null);
  const [movesChannelOpen, setMovesChannelOpen] = useState(false);
  const movesChannelRef = useRef<RTCDataChannel | null>(null);
  const firstFrameTimeoutRef = useRef<number | undefined>(undefined);
  const firstFrameDecodedRef = useRef(false);
  const transportRetryAttemptRef = useRef(0);

  // HID rides this channel over the media path instead of the (possibly
  // tunneled) control WebSocket; null until open, and whenever it is null the
  // caller keeps using the WebSocket. See webrtc-input-channel.ts. Memoized on
  // the open flag so pointer-event callbacks downstream keep a stable identity;
  // the ref is already set by the time the open flag's render happens.
  const inputTarget = useMemo(
    () => (inputChannelOpen ? dataChannelSendTarget(inputChannelRef.current) : null),
    [inputChannelOpen],
  );
  // The lossy lane for touch moves, scroll and crown deltas. Null until open;
  // the router then keeps those on the reliable channel.
  const movesTarget = useMemo(
    () => (movesChannelOpen ? dataChannelSendTarget(movesChannelRef.current) : null),
    [movesChannelOpen],
  );

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
    inputChannelRef.current = null;
    setInputChannelOpen(false);
    movesChannelRef.current = null;
    setMovesChannelOpen(false);
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

    const closePeer = () => {
      setStream(null);
      if (inputChannelRef.current) {
        inputChannelRef.current = null;
        setInputChannelOpen(false);
      }
      if (movesChannelRef.current) {
        movesChannelRef.current = null;
        setMovesChannelOpen(false);
      }
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

        // Created before the offer so the SCTP transport is negotiated with the
        // video. Ordered + reliable: input frames stay in order on this channel,
        // and the router only ever switches transports at gesture boundaries.
        const inputChannel = pc.createDataChannel("input");
        inputChannelRef.current = inputChannel;
        inputChannel.onopen = () => {
          if (!stopped && inputChannelRef.current === inputChannel) setInputChannelOpen(true);
        };
        inputChannel.onclose = () => {
          if (inputChannelRef.current === inputChannel) {
            inputChannelRef.current = null;
            setInputChannelOpen(false);
          }
        };
        // Unordered and lifetime-limited: a move that is not delivered within
        // ~100 ms is dropped rather than retransmitted, and later moves are
        // never held behind it. begin/end are duplicated onto this lane too;
        // the server de-duplicates by gesture id and sequence.
        const movesChannel = pc.createDataChannel("moves", { ordered: false, maxPacketLifeTime: 100 });
        movesChannelRef.current = movesChannel;
        movesChannel.onopen = () => {
          if (!stopped && movesChannelRef.current === movesChannel) setMovesChannelOpen(true);
        };
        movesChannel.onclose = () => {
          if (movesChannelRef.current === movesChannel) {
            movesChannelRef.current = null;
            setMovesChannelOpen(false);
          }
        };

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
          firstFrameTimeoutRef.current = window.setTimeout(() => {
            firstFrameTimeoutRef.current = undefined;
            if (stopped || firstFrameDecodedRef.current) return;
            const state = pc?.connectionState ?? "closed";
            if (webRtcFailureDisposition("first-frame-timeout", state) === "codec") {
              failCodec();
            } else {
              retryTransport("WebRTC did not establish a video path.");
            }
          }, FIRST_FRAME_TIMEOUT_MS);
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
        const response = await postWebRtcOffer({
          url: offerUrl,
          signal: lifecycleController.signal,
          requestTimeoutMs: SIGNALING_REQUEST_TIMEOUT_MS,
          busyRetryIntervalMs: BUSY_RETRY_INTERVAL_MS,
          busyRetryCount: BUSY_RETRY_COUNT,
          body: JSON.stringify({
            type: local.type,
            sdp: local.sdp,
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
      inputChannelRef.current = null;
      setInputChannelOpen(false);
      movesChannelRef.current = null;
      setMovesChannelOpen(false);
      setPeerConnection(null);
      setSessionId(null);
      pc?.close();
    };
  }, [enabled, offerUrl, closeUrl, codec, iceServers, retryGeneration]);

  return { stream, failure, error, markFrameDecoded, peerConnection, sessionId, inputTarget, movesTarget };
}
