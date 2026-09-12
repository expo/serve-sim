import { Ban, Folder, Radio, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";

import {
  useCaptureStream,
  type CaptureAttachment,
  type CaptureMeta,
} from "../hooks/use-capture-stream";
import { runHostAction } from "../utils/exec";
import { simEndpoint } from "../utils/sim-endpoint";
import { CollapsibleSection } from "./collapsible-section";
import {
  DomainSection,
  RequestRow,
  formatBytes,
  groupByDomain,
  isFailedRequest,
} from "./network-capture-requests";

export {
  DomainSection,
  RequestFacts,
  RequestRow,
  TimingBar,
  formatMs,
  groupByDomain,
} from "./network-capture-requests";

export function NetworkCaptureTool({ udid, captureEndpoint }: { udid: string; captureEndpoint?: string }) {
  const path = useMemo(
    () => captureEndpoint ?? `${simEndpoint("network-capture")}?device=${encodeURIComponent(udid)}`,
    [captureEndpoint, udid],
  );
  const bodyBase = useMemo(() => path.split("?")[0]!, [path]);
  const [open, setOpen] = useState(true);
  const [grouped, setGrouped] = useState(false);
  const [filter, setFilter] = useState("");
  const [rebooting, setRebooting] = useState(false);
  const [rebootError, setRebootError] = useState<string | null>(null);
  const [streamKey, setStreamKey] = useState(0);
  const { meta, requests, errored, clear, setMeta } = useCaptureStream(path, streamKey);
  const capturing = meta?.attachment === "capturing";
  const starting = meta?.attachment === "starting";
  const captureOn = capturing || starting;
  const rebootButton = rebootControl({ meta, errored, rebooting });

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched = needle
      ? requests.filter((request) => request.url.toLowerCase().includes(needle))
      : requests;
    return [...matched].reverse();
  }, [requests, filter]);

  const totals = useMemo(
    () => ({
      bytes: rows.reduce((sum, request) => sum + request.requestBytes + request.responseBytes, 0),
      failed: rows.filter(isFailedRequest).length,
    }),
    [rows],
  );
  const slowestMs = useMemo(() => Math.max(1, ...rows.map((request) => request.durationMs ?? 0)), [rows]);
  const groups = useMemo(() => (grouped ? groupByDomain(rows) : []), [grouped, rows]);

  async function reboot(enable: boolean) {
    setRebooting(true);
    setRebootError(null);
    try {
      const result = await runHostAction("capture.reboot", { udid, enabled: enable });
      if (result.exitCode !== 0) {
        setRebootError(result.stderr || "The device could not be rebooted.");
        return;
      }
      setMeta(JSON.parse(result.stdout) as CaptureMeta);
      setStreamKey((key) => key + 1);
    } catch (error) {
      setRebootError(error instanceof Error ? error.message : "The reboot request could not be sent.");
    } finally {
      setRebooting(false);
    }
  }

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      summaryClassName="grid [grid-template-columns:auto_1fr_auto_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">
            Network requests
          </span>
          {errored ? (
            <span className="group relative justify-self-end inline-flex items-center" role="status">
              <TriangleAlert aria-hidden="true" className="w-3.5 h-3.5 text-amber-400" />
              <span className="sr-only">The capture stream disconnected</span>
              <span className="pointer-events-none absolute right-0 top-full z-10 mt-1 hidden w-max max-w-[220px] rounded-md bg-black/90 px-2 py-1 text-[11px] leading-snug text-white/90 shadow-lg group-hover:block">
                The capture stream disconnected
              </span>
            </span>
          ) : (
            <span />
          )}
          <span className="rounded-md border border-white/8 bg-white/[0.04] px-1.5 py-[3px] text-[10px] font-mono text-white/60">
            {rows.length}
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span
            role="status"
            aria-label={capturing ? "Capture enabled" : starting ? "Capture starting" : "Capture disabled"}
            className={`group relative inline-flex items-center rounded p-1 ${
              capturing
                ? "bg-emerald-500/15 text-emerald-300"
                : starting
                  ? "bg-sky-500/15 text-sky-300"
                  : "bg-amber-500/15 text-amber-300"
            }`}
          >
            <Radio aria-hidden="true" className="w-3.5 h-3.5" />
            <span className="pointer-events-none absolute left-0 top-full z-10 mt-1 hidden w-max rounded-md bg-black/90 px-2 py-1 text-[11px] leading-snug text-white/90 shadow-lg group-hover:block">
              {capturing ? "Capture enabled" : starting ? "Capture starting" : "Capture disabled"}
            </span>
          </span>
          <button
            type="button"
            disabled={rebootButton.disabled}
            onClick={() => void reboot(!captureOn)}
            className="rounded px-2 py-1 text-[11px] text-white/60 hover:bg-white/10 disabled:opacity-50"
          >
            {rebootButton.label}
          </button>
        </div>

        {rebootError && (
          <span className="whitespace-pre-line text-[11px] leading-snug text-red-300">{rebootError}</span>
        )}
        <CaptureState attachment={meta?.attachment ?? "not-enabled"} attachError={meta?.attachError ?? null} />
        <OversizedBodiesNotice count={meta?.droppedOversizedBodies ?? 0} />

        {(capturing || rows.length > 0) && (
          <>
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter"
                aria-label="Filter requests by URL"
                className="flex-1 min-w-0 rounded bg-white/5 px-2 py-1 text-[11px] text-white/80 placeholder:text-white/30 focus:outline-none focus:bg-white/10"
              />
              <button
                type="button"
                aria-label="Group by domain"
                aria-pressed={grouped}
                onClick={() => setGrouped((on) => !on)}
                className={`rounded p-1 ${grouped ? "bg-sky-500/15 text-sky-300" : "text-white/40 hover:bg-white/10"}`}
              >
                <Folder aria-hidden="true" className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                aria-label="Clear the live request list"
                title="Clear the live request list"
                onClick={clear}
                className="rounded p-1 text-white/40 hover:bg-white/10"
              >
                <Ban aria-hidden="true" className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="thin-scroll max-h-64 overflow-y-auto pr-1.5 border-t border-white/5">
              {rows.length === 0 ? (
                <span className="block py-2 text-[11px] text-white/40">
                  {filter ? "No requests match that filter." : "No requests captured yet."}
                </span>
              ) : grouped ? (
                groups.map((group) => (
                  <DomainSection
                    key={group.host}
                    group={group}
                    bodyBase={bodyBase}
                    udid={udid}
                    slowestMs={slowestMs}
                  />
                ))
              ) : (
                rows.map((request) => (
                  <RequestRow
                    key={request.id}
                    request={request}
                    bodyBase={bodyBase}
                    udid={udid}
                    slowestMs={slowestMs}
                  />
                ))
              )}
            </div>

            <div className="border-t border-white/5 pt-1.5 text-[11px] text-white/40 tabular-nums">
              {grouped && `${groups.length} domain${groups.length === 1 ? "" : "s"} · `}
              {rows.length} request{rows.length === 1 ? "" : "s"} · {formatBytes(totals.bytes)}
              {totals.failed > 0 && <span className="text-red-400/80"> · {totals.failed} failed</span>}
            </div>
          </>
        )}
      </div>
    </CollapsibleSection>
  );
}

export function rebootControl({
  meta,
  errored,
  rebooting,
}: {
  meta: CaptureMeta | null;
  errored: boolean;
  rebooting: boolean;
}): { disabled: boolean; label: string } {
  if (rebooting) return { disabled: true, label: "Rebooting…" };
  if (meta === null) {
    return errored
      ? { disabled: false, label: "Reboot with capture" }
      : { disabled: true, label: "Reboot with capture" };
  }
  if (meta.attachment === "starting") return { disabled: true, label: "Starting…" };
  return {
    disabled: false,
    label: meta.attachment === "capturing" ? "Reboot without capture" : "Reboot with capture",
  };
}

export function CaptureState({
  attachment,
  attachError,
}: {
  attachment: CaptureAttachment;
  attachError: string | null;
}) {
  if (attachment === "capturing") return null;
  if (attachment === "failed") {
    return (
      <span className="whitespace-pre-line text-[11px] leading-snug text-amber-400/80">
        {attachError ?? "Capture could not start."}
      </span>
    );
  }
  if (attachment === "starting") {
    return <span className="text-[11px] text-white/40">Starting capture on this device…</span>;
  }
  return (
    <span className="whitespace-pre-line text-[11px] leading-snug text-white/40">
      {attachError ?? "This device is not capturing."}
    </span>
  );
}

export function OversizedBodiesNotice({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="flex items-start gap-1.5 text-[11px] leading-snug text-amber-400/80">
      <TriangleAlert aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
      Dropped {count} oversized capture post{count === 1 ? "" : "s"} (over the control-body limit).
      Check the serve-sim terminal for `[capture] Dropped oversized control body`, or raise{" "}
      <code className="text-amber-300/90">SERVE_SIM_CAPTURE_MAX_CONTROL_BODY_BYTES</code>.
    </span>
  );
}
