import { booleanParam } from "../request-params";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { ServeSimDeviceState } from "../state";
import { logBufferCache, type LogBufferCache } from "../log-buffer";
import { openSseStream } from "../sse-stream";
import { crashRuntime, type CrashRuntime } from "./runtime";
import { summarizeCrash, type CrashStreamFrame, type CrashDetailResponse } from "./protocol";

/** A reader keeps the tail alive, so a crash during this stream still has lines before it. */
function holdDeviceTail(buffers: LogBufferCache, udid: string): () => void {
  return buffers.ensure(udid).subscribeBatch(() => {});
}

export function handleCrashesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServeSimDeviceState | null,
  rawUrl = "",
  runtime: CrashRuntime = crashRuntime,
  logBuffers: LogBufferCache = logBufferCache
): void {
  if (!state) {
    res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "No serve-sim device" }));
    return;
  }
  const udid = state.device;
  const wantsStream = (req.headers.accept ?? "").includes("text/event-stream");
  if (wantsStream && (res.destroyed || req.destroyed)) return;
  if (!wantsStream) {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(
      JSON.stringify({ meta: runtime.meta(), crashes: runtime.listFor(udid).map(summarizeCrash) })
    );
    return;
  }

  let lastMeta = JSON.stringify(runtime.meta());
  const stream = openSseStream(req, res, {
    onHeartbeat: () => {
      const next = JSON.stringify(runtime.meta());
      if (next === lastMeta) return;
      lastMeta = next;
      stream.write(`data: {"type":"meta","meta":${next}}\n\n`);
    },
  });

  const { crashes, unsubscribe } = runtime.subscribe(
    udid,
    (event) => {
      const frame: CrashStreamFrame =
        event.type === "evicted" ? event : { type: event.type, record: summarizeCrash(event.record) };
      stream.write("data: " + JSON.stringify(frame) + "\n\n");
    },
    () => {
      if (stream.isOpen()) res.end();
    }
  );
  stream.onClose(unsubscribe);
  // Only a reader that is watching for new crashes pays for keeping the device tail alive.
  if (booleanParam(new URL(rawUrl, "http://127.0.0.1").searchParams, "tail")) {
    stream.onClose(holdDeviceTail(logBuffers, udid));
  }

  stream.write(`data: {"type":"meta","meta":${lastMeta}}\n\n`);
  stream.write(
    "data: " + JSON.stringify({ type: "list", crashes: crashes.map(summarizeCrash) }) + "\n\n"
  );
}

export async function handleCrashReportRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  state: ServeSimDeviceState | null,
  id: string,
  occurrenceParam: string | null = null,
  runtime: CrashRuntime = crashRuntime,
  readReport: (path: string) => Promise<string> = (path) => readFile(path, "utf8")
): Promise<void> {
  const fail = (status: number, error: string): void => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error }));
  };

  if (!state) return fail(404, "No serve-sim device");
  const record = runtime.getFor(state.device, id);
  if (!record) {
    return fail(
      404,
      `No crash with id ${id} for device ${state.device}. Ids come from GET {base}/crashes for ` +
        "the same device, and the newest 20 signatures are kept, so a stale id can age out."
    );
  }

  const total = record.occurrences.length;
  const wanted = occurrenceParam?.trim();
  const requested = wanted ? Number(wanted) : total - 1;
  if (!Number.isInteger(requested) || requested < 0 || requested >= total) {
    return fail(
      400,
      `Occurrence must be 0-${total - 1} for this crash (oldest first); omit it for the newest.`
    );
  }
  const occurrence = record.occurrences[requested]!;

  let report: string | null = null;
  let reportError: string | null = null;
  try {
    report = await readReport(occurrence.rawPath);
  } catch (error) {
    reportError =
      `Could not read ${occurrence.rawPath} (${error instanceof Error ? error.message : String(error)}). ` +
      "macOS ages crash reports into Retired/ and then deletes them, so an older occurrence can be " +
      "gone for good; the summary and this occurrence's log tail are what is left.";
  }

  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  const detail: CrashDetailResponse = {
    record: summarizeCrash(record),
    occurrence: { ...occurrence, index: requested, total },
    report,
    reportError,
  };
  res.end(JSON.stringify(detail));
}
