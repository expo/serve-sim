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
const SIGNALING_TIMEOUT_MS = 10_000;
const FIRST_FRAME_TIMEOUT_MS = 4_000;

export function useWebRtcStream({
  url,
  enabled,
  codec = "h264",
  iceServers,
}: {
  url: string;
  enabled: boolean;
  codec?: WebRtcCodec;
  iceServers?: IceServer[];
}) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [failedCodec, setFailedCodec] = useState<WebRtcCodec | null>(null);
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
  }, []);

  useEffect(() => {
    if (!enabled || !url) return;
    if (typeof RTCPeerConnection === "undefined" || typeof RTCRtpReceiver === "undefined") {
      setStream(null);
      setFailedCodec(codec);
      return;
    }

    let stopped = false;
    let pc: RTCPeerConnection | null = null;
    let dc: RTCDataChannel | null = null;
    let offerController: AbortController | null = null;
    let offerTimeout: number | undefined;
    const servers = iceServers?.length ? iceServers : DEFAULT_ICE_SERVERS;
    setStream(null);
    setFailedCodec(null);
    setDataChannelOpen(false);
    firstFrameDecodedRef.current = false;
    if (firstFrameTimeoutRef.current !== undefined) {
      window.clearTimeout(firstFrameTimeoutRef.current);
      firstFrameTimeoutRef.current = undefined;
    }
    dataChannelRef.current = null;

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
            setStream(null);
            setFailedCodec(codec);
            pc?.close();
          }, FIRST_FRAME_TIMEOUT_MS);
        };
        pc.onconnectionstatechange = () => {
          if (stopped || !pc) return;
          if (pc.connectionState === "failed") {
            setFailedCodec(codec);
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
        let response: Response;
        try {
          response = await fetch(`${url}/webrtc/offer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: offerController.signal,
            body: JSON.stringify({
              type: local.type,
              sdp: local.sdp,
              codec,
              iceServers: servers,
            }),
          });
        } finally {
          if (offerTimeout !== undefined) {
            window.clearTimeout(offerTimeout);
            offerTimeout = undefined;
          }
        }
        if (!response.ok) throw new Error(`WebRTC offer failed: HTTP ${response.status}`);
        const answer = await response.json() as RTCSessionDescriptionInit;
        if (stopped) return;
        await pc.setRemoteDescription(answer);
      } catch {
        if (!stopped) {
          setFailedCodec(codec);
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
      dataChannelRef.current = null;
      setStream(null);
      setDataChannelOpen(false);
      dc?.close();
      pc?.close();
    };
  }, [enabled, url, codec, iceServers]);

  return { stream, dataTarget, failedCodec, markFrameDecoded };
}
