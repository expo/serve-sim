import { parseDeviceLogJson, type DeviceLogFields } from "./device-log-format";
import { startExclusivePoll } from "./exclusive-poll";
import { simAuthHeaders } from "./sim-endpoint";

const LOGS_POLL_MS = 2000;
const LOGS_POLL_LIMIT = 800;
const LOGS_REPLAY_LIMIT = 400;

export type LogSnapshotLine = { seq: number; fields: DeviceLogFields };

export function logsSnapshotUrl(endpoint: string, since: number): string {
  const url = new URL(endpoint, "http://127.0.0.1");
  url.searchParams.set("snapshot", "1");
  url.searchParams.set("follow", "1");
  url.searchParams.set("limit", String(since > 0 ? LOGS_POLL_LIMIT : LOGS_REPLAY_LIMIT));
  if (since > 0) url.searchParams.set("since", String(since));
  return `${url.pathname}${url.search}`;
}

export function parseLogSnapshot(payload: unknown): { latestSeq: number; lines: LogSnapshotLine[] } {
  if (payload === null || typeof payload !== "object") {
    return { latestSeq: 0, lines: [] };
  }
  const record = payload as { latestSeq?: unknown; lines?: unknown };
  const latestSeq =
    typeof record.latestSeq === "number" && Number.isSafeInteger(record.latestSeq)
      ? record.latestSeq
      : 0;
  const rows = Array.isArray(record.lines) ? record.lines : [];
  const lines: LogSnapshotLine[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const item = row as { seq?: unknown; raw?: unknown };
    if (typeof item.seq !== "number" || typeof item.raw !== "string") continue;
    const fields = parseDeviceLogJson(item.raw);
    if (!fields) continue;
    lines.push({ seq: item.seq, fields });
  }
  return { latestSeq, lines };
}

export function startLogsPoll(
  endpoint: string,
  opts: {
    getSince: () => number;
    setSince: (seq: number) => void;
    onBatch: (lines: LogSnapshotLine[]) => void;
    onError?: (errored: boolean) => void;
  }
): () => void {
  let stopped = false;

  const sample = async (): Promise<void> => {
    const since = opts.getSince();
    try {
      const response = await fetch(logsSnapshotUrl(endpoint, since), {
        headers: { Accept: "application/json", ...simAuthHeaders() },
        signal: AbortSignal.timeout(LOGS_POLL_MS * 3),
      });
      if (stopped) return;
      if (!response.ok) {
        opts.onError?.(/* errored */ true);
        return;
      }
      const parsed = parseLogSnapshot(await response.json());
      if (stopped) return;
      opts.onError?.(/* errored */ false);
      if (parsed.latestSeq < since) {
        opts.setSince(0);
        return;
      }
      const fresh = parsed.lines.filter((line) => line.seq > since);
      if (parsed.latestSeq > since) opts.setSince(parsed.latestSeq);
      if (fresh.length > 0) opts.onBatch(fresh);
    } catch {
      if (!stopped) opts.onError?.(/* errored */ true);
    }
  };

  const stopPolling = startExclusivePoll(sample, LOGS_POLL_MS);
  return () => {
    stopped = true;
    stopPolling();
  };
}
