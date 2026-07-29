import { useCallback, useEffect, useState } from "react";

// Type-only — the capture backend's node: imports must not reach the client bundle.
import type {
  CaptureEvent,
  CaptureMeta,
  CaptureAttachment,
  CapturedBody,
  CapturedRequest,
} from "../../capture-store";
import { openHostEventStream } from "../utils/exec";

export type { CaptureMeta, CaptureAttachment, CapturedBody, CapturedRequest };

/**
 * Rows kept in the panel. Mirrors the backend's own window deliberately rather than importing it —
 * `capture-store` uses Buffer, so a value import would drag Node into the browser bundle. Keeping the
 * numbers equal is what stops the list growing for a whole session and, worse, retaining rows the
 * backend evicted while they were still in flight, which can never receive their `finished` frame.
 */
const MAX_ROWS = 500;

/**
 * Subscribe to a device's capture stream. Opening the stream is what starts capture on the backend,
 * so `enabled` is the on/off switch: nothing is proxied and no trust is installed until it is true.
 *
 * The transport strips SSE `event:` lines, so meta and event frames both arrive as messages and are
 * discriminated by shape.
 */
export function useCaptureStream(
  path: string,
  enabled: boolean,
): {
  meta: CaptureMeta | null;
  requests: CapturedRequest[];
  errored: boolean;
  clear: () => void;
} {
  const [meta, setMeta] = useState<CaptureMeta | null>(null);
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [errored, setErrored] = useState(false);

  const clear = useCallback(() => setRequests([]), []);

  useEffect(() => {
    // Reset so toggling off, or switching device, drops the previous session's rows.
    setMeta(null);
    setRequests([]);
    setErrored(false);
    if (!enabled) return;

    const stream = openHostEventStream(path);
    stream.onmessage = ({ data }) => {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        setErrored(false);
        if ("schemaVersion" in parsed) {
          setMeta(parsed as unknown as CaptureMeta);
          return;
        }
        if (parsed.type === "meta") {
          // A later state than the one sent at subscribe time — the proxy stopping, for instance.
          setMeta(parsed.meta as CaptureMeta);
          return;
        }
        const event = parsed as unknown as CaptureEvent;
        if (event.type === "cleared" || event.type === "meta") {
          if (event.type === "cleared") setRequests([]);
          return;
        }
        // `started` then `finished` carry the same id; replace in place so a row updates rather than
        // duplicating, and so a replayed history merges with the live stream cleanly.
        setRequests((prev) => {
          const next = [...prev];
          const at = next.findIndex((r) => r.id === event.request.id);
          if (at === -1) next.push(event.request);
          else next[at] = event.request;
          // Match the backend's window. Without this the list grows for the whole session, and rows the
          // backend has already evicted stay forever — including ones it evicted while still in flight,
          // which can never receive their `finished` frame and would spin indefinitely.
          return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
        });
      } catch {
        // A malformed frame must not kill the stream.
      }
    };
    stream.onerror = () => setErrored(true);
    return () => stream.close();
  }, [path, enabled]);

  return { meta, requests, errored, clear };
}

/** Fetch one request's headers and bodies, which the stream deliberately omits. */
export async function fetchCapturedBody(basePath: string, id: string): Promise<CapturedBody | null> {
  try {
    const response = await fetch(`${basePath}/${encodeURIComponent(id)}`);
    if (!response.ok) return null;
    return (await response.json()) as CapturedBody;
  } catch {
    return null;
  }
}
