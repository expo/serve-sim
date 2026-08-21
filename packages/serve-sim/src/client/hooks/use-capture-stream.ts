import { useCallback, useEffect, useState } from "react";

// Type-only — the capture backend's node: imports must not reach the client bundle.
import {
  MAX_REQUESTS,
  type CaptureEvent,
  type CaptureMeta,
  type CaptureAttachment,
  type CapturedBody,
  type CapturedRequest,
} from "../../capture/store";
import { openHostEventStream } from "../utils/exec";

export type { CaptureMeta, CaptureAttachment, CapturedBody, CapturedRequest };

/** Bearer + optional JSON content-type for capture HTTP routes (same token as /exec). */
export function captureAuthHeaders(opts?: { json?: boolean }): HeadersInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${window.__SIM_PREVIEW__?.execToken ?? ""}`,
  };
  if (opts?.json) headers["Content-Type"] = "application/json";
  return headers;
}

/** Subscribe to capture SSE; `streamKey` bumps after reboot to resubscribe. */
export function useCaptureStream(
  path: string,
  streamKey = 0,
): {
  meta: CaptureMeta | null;
  requests: CapturedRequest[];
  errored: boolean;
  clear: () => void;
  setMeta: (meta: CaptureMeta) => void;
} {
  const [meta, setMeta] = useState<CaptureMeta | null>(null);
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [errored, setErrored] = useState(false);

  const clear = useCallback(() => {
    setRequests([]);
    const base = path.split("?")[0]!;
    const device = new URL(path, "http://local").searchParams.get("device");
    const clearUrl = `${base}/clear${device ? `?device=${encodeURIComponent(device)}` : ""}`;
    void fetch(clearUrl, {
      method: "POST",
      headers: captureAuthHeaders({ json: true }),
      body: "{}",
    }).catch(() => {});
  }, [path]);

  useEffect(() => {
    setErrored(false);
    setRequests([]);
    setMeta(null);
    const stream = openHostEventStream(path);
    stream.onmessage = ({ data }) => {
      try {
        const event = JSON.parse(data) as CaptureEvent;
        setErrored(false);
        if (event.type === "meta") {
          setMeta(event.meta);
          return;
        }
        if (event.type === "cleared") {
          setRequests([]);
          return;
        }
        if (event.type !== "started" && event.type !== "finished") return;
        setRequests((prev) => {
          const next = [...prev];
          const at = next.findIndex((r) => r.id === event.request.id);
          if (at === -1) next.push(event.request);
          else next[at] = event.request;
          return next.length > MAX_REQUESTS ? next.slice(next.length - MAX_REQUESTS) : next;
        });
      } catch {
        // Ignore malformed frames.
      }
    };
    stream.onerror = () => setErrored(true);
    return () => stream.close();
  }, [path, streamKey]);

  return { meta, requests, errored, clear, setMeta };
}

/**
 * Fetch one request's headers and bodies, which the live stream omits.
 *
 * `device` is required: ids restart at `r1` per device, so a body request without it resolves against
 * whichever device the server picks by default and can return another simulator's traffic.
 */
export async function fetchCapturedBody(
  basePath: string,
  id: string,
  device: string,
): Promise<CapturedBody | null> {
  try {
    const url = `${basePath}/${encodeURIComponent(id)}?device=${encodeURIComponent(device)}`;
    const response = await fetch(url, {
      headers: captureAuthHeaders(),
    });
    if (!response.ok) return null;
    return (await response.json()) as CapturedBody;
  } catch {
    return null;
  }
}
