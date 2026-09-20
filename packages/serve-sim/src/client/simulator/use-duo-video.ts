import { useEffect, useRef, type RefObject } from "react";
import { matchesPanelFrame } from "./panel-frame";

export type DuoFramePolicy = "live" | "hold" | "handoff";

type Sink = {
  canvas: RefObject<HTMLCanvasElement | null>;
  current: { aspect: number; maxDimension: number; policy: DuoFramePolicy; onFrame: (width: number, height: number) => void };
};
type Feed = { sinks: Set<Sink>; stop: () => void };
const feeds = new Map<MediaStream, Feed>();

export function useDuoVideo(stream: MediaStream | null | undefined, canvas: RefObject<HTMLCanvasElement | null>,
  aspect: number | undefined, maxDimension: number, onFrame: (width: number, height: number) => void, policy: DuoFramePolicy = "live") {
  const sink = useRef<Sink>({ canvas, current: { aspect: aspect ?? 0, maxDimension, onFrame, policy } });
  sink.current.current = { aspect: aspect ?? 0, maxDimension, onFrame, policy };
  useEffect(() => {
    if (!stream || !aspect) return;
    let feed = feeds.get(stream);
    if (!feed) {
      const sinks = new Set<Sink>();
      const video = document.createElement("video");
      video.muted = true; video.playsInline = true;
      video.dataset.duoWebrtcSource = "";
      video.setAttribute("aria-hidden", "true");
      Object.assign(video.style, { position: "fixed", left: "0", bottom: "0", width: "1px", height: "1px", opacity: "0.001", pointerEvents: "none" });
      document.body.append(video);
      const image = document.createElement("canvas");
      const probe = document.createElement("canvas");
      probe.width = probe.height = 8;
      const probeContext = probe.getContext("2d", { willReadFrequently: true })!;
      let stopped = false, callback = 0;
      const paint = () => {
        if (stopped) return;
        const width = video.videoWidth, height = video.videoHeight;
        if (width && height && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          const limit = Math.max(1, ...[...sinks].map(s => s.current.maxDimension));
          const scale = Math.min(1, limit / Math.max(width, height));
          const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
          if (image.width !== w || image.height !== h) { image.width = w; image.height = h; }
          image.getContext("2d")!.drawImage(video, 0, 0, w, h);
          let lit = true;
          if ([...sinks].some(s => s.current.policy === "handoff" && matchesPanelFrame(width, height, s.current.aspect))) {
            probeContext.drawImage(image, 0, 0, 8, 8);
            lit = probeContext.getImageData(0, 0, 8, 8).data.some((v, i) => i % 4 !== 3 && v > 40);
          }
          for (const sink of sinks) {
            const target = sink.canvas.current;
            if (target && matchesPanelFrame(width, height, sink.current.aspect)) {
              target.dataset.duoDecodedAt = String(performance.now());
              if (sink.current.policy === "hold" || (sink.current.policy === "handoff" && !lit)) continue;
              if (target.width !== w || target.height !== h) { target.width = w; target.height = h; }
              target.getContext("2d")!.drawImage(image, 0, 0);
              target.dataset.duoFrameAt = String(performance.now());
            }
            sink.current.onFrame(width, height);
          }
        }
        if (video.requestVideoFrameCallback) callback = video.requestVideoFrameCallback(paint);
      };
      video.srcObject = stream;
      if (video.requestVideoFrameCallback) callback = video.requestVideoFrameCallback(paint);
      else video.addEventListener("timeupdate", paint);
      void video.play().catch(() => {});
      feed = { sinks, stop: () => {
        stopped = true;
        if (callback) video.cancelVideoFrameCallback(callback);
        video.removeEventListener("timeupdate", paint);
        video.pause(); video.srcObject = null; video.remove();
      } };
      feeds.set(stream, feed);
    }
    feed.sinks.add(sink.current);
    const subscribed = sink.current;
    return () => {
      feed.sinks.delete(subscribed);
      if (!feed.sinks.size) { feed.stop(); feeds.delete(stream); }
    };
  }, [stream, canvas, aspect]);
}
