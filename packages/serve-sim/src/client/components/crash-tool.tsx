import { useEffect, useMemo, useState } from "react";
import { useCrashDetail } from "../hooks/use-crash-detail";
import {
  applyCrashFrame,
  EMPTY_CRASH_LIST,
  type CrashListState,
} from "../utils/crash-stream";
import { crashStreamUrl, formatCrashAgo } from "../utils/crash-format";
import { watchCrashes } from "../utils/watch-crashes";
import { simEndpoint } from "../utils/sim-endpoint";
import { CollapsibleSection } from "./collapsible-section";
import { CrashDetailModal } from "./crash-detail-modal";

export function CrashTool({ udid, crashesEndpoint }: { udid: string; crashesEndpoint?: string }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<CrashListState>(EMPTY_CRASH_LIST);
  const [now, setNow] = useState(() => Date.now());
  const [streamError, setStreamError] = useState<string | null>(null);

  const path = useMemo(
    () => crashesEndpoint ?? `${simEndpoint("crashes")}?device=${encodeURIComponent(udid)}`,
    [crashesEndpoint, udid]
  );
  // Watching costs a device log tail, so ask for one only while the section is showing crashes.
  const streamPath = crashStreamUrl(path, open);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    setList(EMPTY_CRASH_LIST);
    return watchCrashes(
      streamPath,
      (frame) => {
        setStreamError(null);
        setList((prev) => applyCrashFrame(prev, frame));
      },
      () => setStreamError("Lost contact with serve-sim. Showing the last crash list read."),
    );
  }, [streamPath]);

  const {
    detail,
    pendingIndex,
    error: detailError,
    load: loadDetail,
    select: selectOccurrence,
    step: stepOccurrence,
    close: closeDetail,
  } = useCrashDetail(path, list.crashes);
  const loadError = detailError ?? streamError;

  const crashes = list.crashes;
  const evicted = list.ready && detail !== null && !crashes.some((crash) => crash.id === detail.record.id);
  const unavailable = list.meta?.status === "unavailable";

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      data-crashes=""
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none">
            Crashes
          </span>
          <span
            className={`justify-self-end rounded-md border px-1.5 py-[3px] text-[10px] font-mono ${
              crashes.length > 0
                ? "border-red-400/30 bg-red-400/10 text-red-300"
                : "border-white/8 bg-white/[0.04] text-white/60"
            }`}
          >
            {crashes.length}
          </span>
        </>
      }
    >
      {loadError && !detail && (
        <p role="status" className="text-[11px] text-amber-300/80">
          {loadError}
        </p>
      )}
      {unavailable ? (
        <p className="text-[11px] leading-relaxed text-amber-300/80">{list.meta?.statusError}</p>
      ) : crashes.length === 0 ? (
        <p className="text-[11px] text-white/40">
          No crashes. A report shows up a few seconds after a crash.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {crashes.map((crash) => (
            <li key={crash.id}>
              <button
                type="button"
                onClick={() => {
                  if (detail) return;
                  void loadDetail(crash.id);
                }}
                className="w-full rounded-md bg-white/[0.03] px-2 py-1.5 text-left hover:bg-white/[0.06]"
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-red-300">
                    {crash.signal ?? crash.exceptionType ?? "crash"}
                  </span>
                  {crash.count > 1 && (
                    <span className="rounded border border-red-400/30 px-1 text-[10px] font-mono text-red-300">
                      ×{crash.count}
                    </span>
                  )}
                  <span className="truncate text-[11px] text-white/50">{crash.appName}</span>
                  <span
                    title={
                      crash.capturedAtMs === null
                        ? (crash.capturedAt ?? "")
                        : new Date(crash.capturedAtMs).toLocaleTimeString()
                    }
                    className="ml-auto shrink-0 font-mono text-[10px] text-white/35"
                  >
                    {formatCrashAgo(crash.capturedAtMs, now)}
                  </span>
                </span>
                <span className="mt-0.5 block truncate font-mono text-[10px] text-white/40">
                  {crash.culpritFrame ?? crash.terminationIndicator ?? "no stack frame"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {detail && (
        <CrashDetailModal
          record={detail.record}
          occurrence={detail.occurrence}
          report={detail.report}
          reportError={detail.reportError}
          now={now}
          pendingIndex={pendingIndex ?? detail.occurrence.index}
          loadError={
            evicted
              ? "This crash aged out of the device's list. What is shown is the last copy read."
              : loadError
          }
          onSelectOccurrence={selectOccurrence}
          onStepOccurrence={stepOccurrence}
          onClose={closeDetail}
        />
      )}
    </CollapsibleSection>
  );
}
