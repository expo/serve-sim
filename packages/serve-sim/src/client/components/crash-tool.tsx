import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CrashSummary } from "../../crash/store";
import {
  applyCrashFrame,
  EMPTY_CRASH_LIST,
  parseCrashFrame,
  type CrashListState,
} from "../utils/crash-stream";
import { crashDetailUrl, formatCrashAgo } from "../utils/crash-format";
import { openHostEventStream } from "../utils/exec";
import { simAuthHeaders, simEndpoint } from "../utils/sim-endpoint";
import { CollapsibleSection } from "./collapsible-section";
import { CrashDetailModal, type SelectedOccurrence } from "./crash-detail-modal";


function authorizedFetch(url: string): Promise<Response> {
  return fetch(url, { headers: simAuthHeaders() });
}

type CrashDetail = {
  record: CrashSummary;
  occurrence: SelectedOccurrence;
  report: string | null;
  reportError: string | null;
};

export function CrashTool({ udid, crashesEndpoint }: { udid: string; crashesEndpoint?: string }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<CrashListState>(EMPTY_CRASH_LIST);
  const [detail, setDetail] = useState<CrashDetail | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [evicted, setEvicted] = useState(false);
  const fetchGenRef = useRef(0);
  const requestedRef = useRef<number | null>(null);
  const confirmedRef = useRef<number | null>(null);
  const reloadedForRef = useRef<string | null>(null);

  const path = useMemo(
    () => crashesEndpoint ?? `${simEndpoint("crashes")}?device=${encodeURIComponent(udid)}`,
    [crashesEndpoint, udid]
  );
  // Watching costs a device log tail, so ask for one only while the section is showing crashes.
  const streamPath = open ? `${path}${path.includes("?") ? "&" : "?"}tail=1` : path;

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    setList(EMPTY_CRASH_LIST);
    setEvicted(false);
    const stream = openHostEventStream(streamPath);
    stream.onmessage = ({ data }) => {
      const frame = parseCrashFrame(data);
      if (!frame) return;
      setLoadError(null);
      setList((prev) => applyCrashFrame(prev, frame));
    };
    stream.onerror = () =>
      setLoadError("Lost contact with serve-sim. Showing the last crash list read.");
    return () => stream.close();
  }, [streamPath]);

  const loadDetail = useCallback(
    async (id: string, occurrence?: number): Promise<void> => {
      const gen = ++fetchGenRef.current;
      setLoadError(null);
      const revert = (): void => {
        if (gen !== fetchGenRef.current) return;
        requestedRef.current = confirmedRef.current;
        setPendingIndex(confirmedRef.current);
        setLoadError("Could not load that crash.");
      };
      try {
        const response = await authorizedFetch(crashDetailUrl(path, id, occurrence));
        if (!response.ok) {
          revert();
          return;
        }
        const next = (await response.json()) as CrashDetail;
        if (gen !== fetchGenRef.current) return;
        requestedRef.current = next.occurrence.index;
        confirmedRef.current = next.occurrence.index;
        setPendingIndex(next.occurrence.index);
        setDetail(next);
      } catch {
        revert();
      }
    },
    [path]
  );

  useEffect(() => {
    if (!detail) return;
    const listed = list.crashes.find((crash) => crash.id === detail.record.id);
    // The device dropped this crash to stay under its cap, so nothing can refresh it now.
    if (!listed) {
      setEvicted(true);
      return;
    }
    setEvicted(false);
    const remapped = listed.occurrenceTimes.findIndex(
      (stamp) => stamp.rawPath === detail.occurrence.rawPath
    );
    // A list older than the open detail misses it too, so reload at most once per report.
    if (remapped === -1) {
      if (reloadedForRef.current === detail.occurrence.rawPath) return;
      reloadedForRef.current = detail.occurrence.rawPath;
      void loadDetail(detail.record.id, listed.occurrenceCount - 1);
      return;
    }
    const total = listed.occurrenceCount;
    if (
      listed.count === detail.record.count &&
      total === detail.occurrence.total &&
      remapped === detail.occurrence.index
    ) {
      return;
    }
    if (requestedRef.current === detail.occurrence.index) requestedRef.current = remapped;
    if (confirmedRef.current === detail.occurrence.index) confirmedRef.current = remapped;
    setPendingIndex((pending) => (pending === detail.occurrence.index ? remapped : pending));
    setDetail((prev) =>
      prev && prev.record.id === listed.id
        ? {
            ...prev,
            record: listed,
            occurrence: { ...prev.occurrence, index: remapped, total },
          }
        : prev
    );
  }, [list, detail, loadDetail]);

  const selectOccurrence = (index: number): void => {
    if (!detail) return;
    if (index < 0 || index >= detail.occurrence.total) return;
    if (index === requestedRef.current) return;
    requestedRef.current = index;
    setPendingIndex(index);
    void loadDetail(detail.record.id, index);
  };

  const stepOccurrence = (delta: number): boolean => {
    const index = (requestedRef.current ?? detail?.occurrence.index ?? 0) + delta;
    if (!detail || index < 0 || index >= detail.occurrence.total) return false;
    if (index === requestedRef.current) return false;
    selectOccurrence(index);
    return true;
  };

  const crashes = list.crashes;
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
          onClose={() => {
            fetchGenRef.current += 1;
            requestedRef.current = null;
            confirmedRef.current = null;
            setPendingIndex(null);
            setLoadError(null);
            setDetail(null);
          }}
        />
      )}
    </CollapsibleSection>
  );
}
