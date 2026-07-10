import { useCallback, useEffect, useRef, useState } from "react";
import type { WebRtcCodec } from "../webrtc-codec-fallback";
import { WEBRTC_ICE_TRANSPORT_POLICY, type IceServer } from "../webrtc-ice";

export type DataChannelTarget = {
  readyState: number;
  send(data: ArrayBuffer): void;
};

const DEFAULT_ICE_SERVERS: IceServer[] = [
  { urls: ["stun:stun.l.google.com:19302"] },
  { urls: ["stun:stun1.l.google.com:19302"] },
];
const ICE_GATHERING_TIMEOUT_MS = 3_000;
// Native signaling has its own 10s deadline. Keep the browser deadline longer
// so the server always gets the first chance to close a timed-out session.
const SIGNALING_TIMEOUT_MS = 15_000;
const FIRST_FRAME_TIMEOUT_MS = 4_000;
const BUSY_RETRY_INTERVAL_MS = 500;
const BUSY_RETRY_COUNT = 20;

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
  const [failedCodec, setFailedCodec] = useState<WebRtcCodec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dataChannelOpen, setDataChannelOpen] = useState(false);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const firstFrameTimeoutRef = useRef<number | undefined>(undefined);
  const firstFrameDecodedRef = useRef(false);

  const dataTarget: DataChannelTarget | null =
    dataChannelOpen && dataChannelRef.current && dataChannelRef.current.readyState === "open"
      ? {
          readyState: 1,
          send: (data) => dataChannelRef.current?.send(data),
        }
      : null;

  const markFrameDecoded = useCallback(() => {
    firstFrameDecodedRef.current = true;
    if (firstFrameTimeoutRef.current !== undefined) {
      window.clearTimeout(firstFrameTimeoutRef.current);
      firstFrameTimeoutRef.current = undefined;
    }
    setFailedCodec(null);
    setError(null);
  }, []);

  useEffect(() => {
    if (!enabled || !offerUrl) return;
    if (typeof RTCPeerConnection === "undefined" || typeof RTCRtpReceiver === "undefined") {
      setStream(null);
      setFailedCodec(null);
      setError("WebRTC is not supported by this browser.");
      return;
    }

    let stopped = false;
    let pc: RTCPeerConnection | null = null;
    let dc: RTCDataChannel | null = null;
    let offerController: AbortController | null = null;
    let offerTimeout: number | undefined;
    let closePromise: Promise<void> | null = null;
    let failing = false;
    const sessionId = createSessionId();
    const servers = iceServers?.length ? iceServers : DEFAULT_ICE_SERVERS;
    setStream(null);
    setFailedCodec(null);
    setError(null);
    setDataChannelOpen(false);
    firstFrameDecodedRef.current = false;
    if (firstFrameTimeoutRef.current !== undefined) {
      window.clearTimeout(firstFrameTimeoutRef.current);
      firstFrameTimeoutRef.current = undefined;
    }
    dataChannelRef.current = null;

    const closeRemoteSession = (keepalive = false): Promise<void> => {
      if (closePromise) return closePromise;
      closePromise = fetch(closeUrl, {
        method: "POST",
        body: JSON.stringify({ sessionId }),
        keepalive,
      }).then(() => undefined, () => undefined);
      return closePromise;
    };

    const failCodec = () => {
      if (stopped || failing) return;
      failing = true;
      setStream(null);
      dc?.close();
      pc?.close();
      void closeRemoteSession().finally(() => {
        if (!stopped) setFailedCodec(codec);
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
          if (connection.iceGatheringState !== "complete") return;
          finish();
        };
        connection.addEventListener("icegatheringstatechange", onState);
        timeout = window.setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
      });

    (async () => {
      try {
        pc = new RTCPeerConnection({
          iceServers: servers,
          iceTransportPolicy: WEBRTC_ICE_TRANSPORT_POLICY,
        });
        dc = pc.createDataChannel("input");
        dataChannelRef.current = dc;

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

        dc.onopen = () => {
          if (!stopped) {
            setDataChannelOpen(true);
          }
        };
        dc.onclose = () => {
          if (!stopped) {
            setDataChannelOpen(false);
          }
        };
        pc.ontrack = (event) => {
          if (stopped) return;
          firstFrameDecodedRef.current = false;
          setStream(event.streams[0] ?? new MediaStream([event.track]));
          if (firstFrameTimeoutRef.current !== undefined) {
            window.clearTimeout(firstFrameTimeoutRef.current);
          }
          firstFrameTimeoutRef.current = window.setTimeout(() => {
            firstFrameTimeoutRef.current = undefined;
            if (stopped || firstFrameDecodedRef.current) return;
            failCodec();
          }, FIRST_FRAME_TIMEOUT_MS);
        };
        pc.onconnectionstatechange = () => {
          if (stopped || !pc) return;
          if (pc.connectionState === "failed") {
            failCodec();
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIce(pc);
        const local = pc.localDescription;
        if (!local) throw new Error("WebRTC offer was not created");
        offerController = new AbortController();
        offerTimeout = window.setTimeout(() => {
          offerController?.abort();
        }, SIGNALING_TIMEOUT_MS);
        let response: Response | null = null;
        try {
          for (let attempt = 0; attempt <= BUSY_RETRY_COUNT; attempt++) {
            response = await fetch(offerUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: offerController.signal,
              body: JSON.stringify({
                type: local.type,
                sdp: local.sdp,
                sessionId,
                codec,
                iceServers: servers,
              }),
            });
            if (response.status !== 409) break;
            await response.body?.cancel();
            if (attempt === BUSY_RETRY_COUNT) {
              setError("This simulator already has an active WebRTC viewer.");
              dc?.close();
              pc?.close();
              setDataChannelOpen(false);
              return;
            }
            await new Promise((resolve) => window.setTimeout(resolve, BUSY_RETRY_INTERVAL_MS));
            if (stopped) return;
          }
        } finally {
          if (offerTimeout !== undefined) {
            window.clearTimeout(offerTimeout);
            offerTimeout = undefined;
          }
        }
        if (!response) throw new Error("WebRTC signaling did not return a response");
        if (!response.ok) throw new Error(`WebRTC offer failed: HTTP ${response.status}`);
        const answer = await response.json() as RTCSessionDescriptionInit;
        if (stopped) {
          await closeRemoteSession(true);
          return;
        }
        await pc.setRemoteDescription(answer);
      } catch {
        if (!stopped) {
          await closeRemoteSession();
          if (!stopped) setFailedCodec(codec);
        }
      }
    })();

    return () => {
      stopped = true;
      if (offerTimeout !== undefined) window.clearTimeout(offerTimeout);
      if (firstFrameTimeoutRef.current !== undefined) {
        window.clearTimeout(firstFrameTimeoutRef.current);
        firstFrameTimeoutRef.current = undefined;
      }
      offerController?.abort();
      void closeRemoteSession(true);
      dataChannelRef.current = null;
      setStream(null);
      setDataChannelOpen(false);
      dc?.close();
      pc?.close();
    };
  }, [enabled, offerUrl, closeUrl, codec, iceServers]);

  return { stream, dataTarget, failedCodec, error, markFrameDecoded };
}
