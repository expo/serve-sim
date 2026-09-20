import { matchesPanelFrame } from "./panel-frame";
import { useEffect, useRef } from "react";
import {
  AvccDemuxer,
  avcCodecString,
  isAvccSupported,
  type AvccChunkType,
} from "../avcc-codec.js";

export interface UseAvccStreamOptions {
  /** Base server URL, e.g. "http://localhost:3100". */
  url: string;
  /** When false, the hook tears down any active decode and does nothing. */
  enabled: boolean;
  /** Target canvas the decoded frames are painted into. */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Called the first time any frame (seed or decoded) is painted. */
  onFirstFrame?: () => void;
  frameAspectRatio?: number;
  /** Called on every painted frame — drives the FPS counter / staleness check. */
  onFrame?: () => void;
  /** Called once after the first decoded H.264 frame is painted (never for the JPEG seed). */
  onDecodedFrame?: () => void;
  /** Called with a human-readable message when the decode pipeline fails. */
  onError?: (message: string) => void;
  /**
   * Called when the WebCodecs decoder itself fails fatally (a `VideoDecoder`
   * `error` event or a `configure()` throw) — as opposed to a network/stream
   * hiccup. When provided it *replaces* {@link onError} for these failures: the
   * consumer is expected to downgrade to MJPEG (hardware H.264 decode is no
   * longer viable — e.g. a screen recorder starving VideoToolbox), so the
   * failure is recovered from rather than surfaced as a user-facing error.
   */
  onDecoderError?: () => void;
}

const RETRY_DELAY_MS = 1000;
/** ~60fps monotonic tick. Never displayed — WebCodecs just needs increasing PTS. */
const FRAME_DURATION_US = 16_667;

/**
 * Decode an H.264 `/stream.avcc` feed into `canvasRef` via WebCodecs.
 *
 * The decode pipeline is keyed only on `url` and `enabled`; the callbacks are
 * read through a ref so passing fresh closures every render does not restart the
 * stream. A no-op when AVCC is unsupported, `enabled` is false, or `url` is
 * empty (a device-less preview config would otherwise fetch a relative
 * `undefined/stream.avcc` from the page origin).
 */
export function useAvccStream({
  url,
  enabled,
  canvasRef,
  onFirstFrame,
  frameAspectRatio,
  onFrame,
  onDecodedFrame,
  onError,
  onDecoderError,
}: UseAvccStreamOptions): void {
  // Latest-callback ref: keeps the decode effect off the callback identities.
  const callbacks = useRef({ onFirstFrame, onFrame, onDecodedFrame, onError, onDecoderError, frameAspectRatio });
  callbacks.current = { onFirstFrame, onFrame, onDecodedFrame, onError, onDecoderError, frameAspectRatio };

  useEffect(() => {
    if (!enabled || !url || !isAvccSupported()) return;
    const subscriber: Subscriber = { canvasRef, callbacks, painted: false, decoded: false };
    let stream = streams.get(url);
    if (!stream) {
      stream = startStream(url);
      streams.set(url, stream);
    }
    stream.subscribers.add(subscriber);
    if (stream.latest.width > 0 && stream.hasFrame) paintSubscriber(subscriber, stream.latest, false);
    return () => {
      stream.subscribers.delete(subscriber);
      if (stream.subscribers.size === 0) {
        stream.stop();
        streams.delete(url);
      }
    };
  }, [url, enabled, canvasRef]);
}

type Callbacks = Pick<UseAvccStreamOptions, "onFirstFrame" | "onFrame" | "onDecodedFrame" | "onError" | "onDecoderError" | "frameAspectRatio">;
type Subscriber = {
  canvasRef: UseAvccStreamOptions["canvasRef"];
  callbacks: { current: Callbacks };
  painted: boolean;
  decoded: boolean;
};
type SharedStream = {
  subscribers: Set<Subscriber>;
  latest: HTMLCanvasElement;
  hasFrame: boolean;
  stop: () => void;
};
const streams = new Map<string, SharedStream>();

function paintSubscriber(subscriber: Subscriber, source: HTMLCanvasElement, decoded: boolean) {
  const canvas = subscriber.canvasRef.current;
  if (!canvas) return;
  const aspect = subscriber.callbacks.current.frameAspectRatio;
  const matchesPanel = matchesPanelFrame(source.width, source.height, aspect);
  if (matchesPanel && (canvas.width !== source.width || canvas.height !== source.height)) {
    canvas.width = source.width;
    canvas.height = source.height;
  }
  if (matchesPanel) canvas.getContext("2d")?.drawImage(source, 0, 0);
  subscriber.callbacks.current.onFrame?.();
  if (decoded && !subscriber.decoded) {
    subscriber.decoded = true;
    subscriber.callbacks.current.onDecodedFrame?.();
  }
  if (!subscriber.painted) {
    subscriber.painted = true;
    subscriber.callbacks.current.onFirstFrame?.();
  }
}

function startStream(url: string): SharedStream {
    const subscribers = new Set<Subscriber>();
    const latest = document.createElement("canvas");
    const stream: SharedStream = { subscribers, latest, hasFrame: false, stop: () => {} };
    const controller = new AbortController();
    const demuxer = new AvccDemuxer();
    let stopped = false;
    let frameRevision = 0;
    let timestamp = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let decoder: VideoDecoder | null = null;

    const isLive = () => !stopped && !controller.signal.aborted;

    // A fatal decode failure routes to onDecoderError (downgrade to MJPEG) when
    // a handler is wired, else surfaces as a user-facing error. Routing to both
    // would flash a red overlay over the stream the parent is about to recover.
    const reportDecodeFailure = (message: string) => {
      for (const { callbacks } of subscribers) {
        if (callbacks.current.onDecoderError) callbacks.current.onDecoderError();
        else callbacks.current.onError?.(message);
      }
    };

    const paint = (source: CanvasImageSource, width: number, height: number, decoded: boolean) => {
      if (!isLive()) return;
      if (latest.width !== width || latest.height !== height) {
        latest.width = width; latest.height = height;
      }
      latest.getContext("2d")?.drawImage(source, 0, 0, width, height);
      stream.hasFrame = true;
      frameRevision++;
      for (const subscriber of subscribers) paintSubscriber(subscriber, latest, decoded);
    };

    const makeDecoder = () => {
      const next = new VideoDecoder({
        output: (frame) => {
          try {
            if (isLive() && decoder === next) paint(frame, frame.displayWidth, frame.displayHeight, true);
          } finally {
            frame.close();
          }
        },
        error: (err) => {
          if (isLive() && decoder === next) reportDecodeFailure(`decoder: ${err.message}`);
        },
      });
      return next;
    };

    const paintSeed = async (jpeg: Uint8Array) => {
      const revision = frameRevision;
      const bitmap = await createImageBitmap(
        new Blob([jpeg as BlobPart], { type: "image/jpeg" }),
      );
      try {
        if (isLive() && revision === frameRevision) paint(bitmap, bitmap.width, bitmap.height, false);
      } finally {
        bitmap.close();
      }
    };

    const configureDecoder = (description: Uint8Array) => {
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = makeDecoder();
      try {
        decoder.configure({
          codec: avcCodecString(description),
          description,
          optimizeForLatency: true,
          hardwareAcceleration: "prefer-hardware",
        });
      } catch (err) {
        reportDecodeFailure(`config: ${(err as Error).message}`);
      }
    };

    const decodeFrame = (type: "keyframe" | "delta", data: Uint8Array) => {
      if (decoder?.state !== "configured") return;
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: type === "keyframe" ? "key" : "delta",
            timestamp,
            data,
          }),
        );
        timestamp += FRAME_DURATION_US;
      } catch {
        /* drop undecodable frame */
      }
    };

    const handleChunk = (type: AvccChunkType, payload: Uint8Array) => {
      switch (type) {
        case "seed":
          void paintSeed(payload).catch(() => {});
          return;
        case "description":
          configureDecoder(payload);
          return;
        case "keyframe":
        case "delta":
          decodeFrame(type, payload);
          return;
      }
    };

    const scheduleRetry = () => {
      if (!isLive() || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void read();
      }, RETRY_DELAY_MS);
    };

    const read = async () => {
      // Each HTTP response is a self-contained stream that opens with its own
      // description — drop any partial bytes left over from a dropped connection.
      demuxer.reset();
      try {
        const res = await fetch(`${url}/stream.avcc`, {
          signal: controller.signal,
        });
        const reader = res.body?.getReader();
        if (!reader) return;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          for (const chunk of demuxer.push(value)) {
            handleChunk(chunk.type, chunk.payload);
          }
        }
      } catch {
        /* aborted or network error — falls through to retry */
      } finally {
        if (isLive()) scheduleRetry();
      }
    };

    void read();

    stream.stop = () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller.abort();
      demuxer.reset();
      if (decoder && decoder.state !== "closed") {
        try {
          decoder.close();
        } catch {
          /* already closed */
        }
      }
      decoder = null;
    };
    return stream;
}
