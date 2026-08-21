import { dirname, join } from "node:path";

import { CaptureDiskAccumulator, NETWORK_CAPTURE_FILENAME } from "./disk";
import { parseFinishedCaptureRequest } from "./har";
import type { CapturedBody } from "./store";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface FollowCaptureHarOptions {
  baseUrl: string;
  device: string;
  outPath: string;
  eventsPath?: string;
  flushIntervalMs?: number;
  signal?: AbortSignal;
  version?: string;
  fetchImpl?: FetchLike;
  /** Bearer token for capture routes (from serve-sim device state / preview). */
  token: string;
}

export interface FollowCaptureHarResult {
  size: number;
  harPath: string;
  eventsPath: string;
  entriesPath: string;
}

function defaultEventsPath(harPath: string): string {
  return join(dirname(harPath), NETWORK_CAPTURE_FILENAME);
}

async function fetchBody(
  baseUrl: string,
  device: string,
  id: string,
  fetchImpl: FetchLike,
  token: string,
  signal?: AbortSignal,
): Promise<CapturedBody | null> {
  const withDevice = new URL(`/network-capture/${encodeURIComponent(id)}`, baseUrl);
  withDevice.searchParams.set("device", device);
  try {
    const res = await fetchImpl(withDevice, {
      signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.warn(`Network capture: body fetch HTTP ${res.status} for ${id}`);
      return null;
    }
    return (await res.json()) as CapturedBody;
  } catch (error) {
    console.warn(
      `Network capture: body fetch failed for ${id}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** Follow /network-capture SSE into the same NDJSON → streamed HAR layout as the live session. */
export async function followCaptureHar(opts: FollowCaptureHarOptions): Promise<FollowCaptureHarResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const eventsPath = opts.eventsPath ?? defaultEventsPath(opts.outPath);
  const version = opts.version ?? "0.0.0";
  const dir = dirname(opts.outPath);

  const disk = new CaptureDiskAccumulator({
    dir,
    harPath: opts.outPath,
    networkCapturePath: eventsPath,
    creatorVersion: version,
    flushIntervalMs: opts.flushIntervalMs ?? 5_000,
  });
  disk.begin();

  const streamUrl = new URL(
    `/network-capture?device=${encodeURIComponent(opts.device)}`,
    opts.baseUrl,
  ).toString();

  const res = await fetchImpl(streamUrl, {
    headers: {
      accept: "text/event-stream",
      Authorization: `Bearer ${opts.token}`,
    },
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    await disk.end({ removeDir: false });
    throw new Error(`capture stream HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        disk.recordEvent(data);
        const finished = parseFinishedCaptureRequest(data);
        if (!finished) continue;
        const body = await fetchBody(
          opts.baseUrl,
          opts.device,
          finished.id,
          fetchImpl,
          opts.token,
          opts.signal,
        );
        disk.recordFinished(finished, body);
      }
    }
  } finally {
    await disk.end({ removeDir: false });
  }

  return {
    size: disk.size,
    harPath: disk.harPath,
    eventsPath: disk.networkCapturePath,
    entriesPath: disk.entriesPath,
  };
}
