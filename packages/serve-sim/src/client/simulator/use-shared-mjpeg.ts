import { useEffect, useRef } from "react";

type Subscribe = (listener: (url: string) => void) => () => void;
type Sink = { current: (source: HTMLCanvasElement) => void };
type Feed = { sinks: Set<Sink>; stop: () => void };
const feeds = new Map<Subscribe, Feed>();

export function useSharedMjpeg(subscribe: Subscribe | undefined, enabled: boolean,
  onFrame: (source: HTMLCanvasElement) => void) {
  const sink = useRef(onFrame);
  sink.current = onFrame;
  useEffect(() => {
    if (!enabled || !subscribe) return;
    let feed = feeds.get(subscribe);
    if (!feed) {
      const sinks = new Set<Sink>();
      const image = new Image();
      const canvas = document.createElement("canvas");
      let stopped = false;
      let decoding: string | null = null;
      let pending: string | null = null;
      const drain = () => {
        if (stopped || decoding || !pending) return;
        decoding = pending; pending = null;
        image.src = decoding;
      };
      const finish = () => {
        if (decoding) URL.revokeObjectURL(decoding);
        decoding = null;
        drain();
      };
      image.onload = () => {
        if (!stopped) {
          if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
            canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
          }
          canvas.getContext("2d")?.drawImage(image, 0, 0);
          for (const listener of sinks) listener.current(canvas);
        }
        finish();
      };
      image.onerror = finish;
      const unsubscribe = subscribe((url) => {
        if (pending) URL.revokeObjectURL(pending);
        pending = url;
        drain();
      });
      feed = { sinks, stop: () => {
        stopped = true;
        unsubscribe();
        image.onload = image.onerror = null;
        image.removeAttribute("src");
        if (decoding) URL.revokeObjectURL(decoding);
        if (pending) URL.revokeObjectURL(pending);
      } };
      feeds.set(subscribe, feed);
    }
    feed.sinks.add(sink);
    return () => {
      feed.sinks.delete(sink);
      if (!feed.sinks.size) { feed.stop(); feeds.delete(subscribe); }
    };
  }, [subscribe, enabled]);
}
