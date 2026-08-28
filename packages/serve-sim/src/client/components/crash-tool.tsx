import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CrashSummary } from "../../crash/store";
import { formatCrashAgo, remapOccurrenceIndex } from "../utils/crash-format";
import { simEndpoint } from "../utils/sim-endpoint";
import { CollapsibleSection } from "./collapsible-section";
import { CrashDetailModal, type SelectedOccurrence } from "./crash-detail-modal";

type CrashListPayload = {
  meta: { status: "idle" | "watching" | "unavailable"; statusError: string | null };
  crashes: CrashSummary[];
};

const POLL_INTERVAL_MS = 5_000;

type CrashDetail = {
  record: CrashSummary;
  occurrence: SelectedOccurrence;
  report: string | null;
  reportError: string | null;
};

export function CrashTool({ udid, crashesEndpoint }: { udid: string; crashesEndpoint?: string }) {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<CrashListPayload | null>(null);
  const [detail, setDetail] = useState<CrashDetail | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fetchGen = useRef(0);
  const requested = useRef<number | null>(null);
  const confirmed = useRef<number | null>(null);

  const path = useMemo(
    () => crashesEndpoint ?? `${simEndpoint("crashes")}?device=${encodeURIComponent(udid)}`,
    [crashesEndpoint, udid]
  );

  // `/crashes` needs the bearer token, which EventSource cannot send, so poll instead.
  const authorized = useCallback(
    (url: string) =>
      fetch(url, {
        headers: { Authorization: `Bearer ${window.__SIM_PREVIEW__?.execToken ?? ""}` },
      }),
    []
  );

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let gen = 0;
    const load = async (): Promise<void> => {
      const thisGen = ++gen;
      try {
        const response = await authorized(path);
        if (!response.ok) return;
        const next = (await response.json()) as CrashListPayload;
        if (cancelled || thisGen !== gen) return;
        setPayload(next);
      } catch {}
    };
    void load();
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [path, authorized]);

  const loadDetail = useCallback(
    async (id: string, occurrence?: number): Promise<void> => {
      const gen = ++fetchGen.current;
      setLoadError(null);
      const query = occurrence === undefined ? "" : `?occurrence=${occurrence}`;
      const failMessage =
        confirmed.current === null ? "Could not load that crash." : "Could not load that occurrence.";
      const revert = (): void => {
        if (gen !== fetchGen.current) return;
        requested.current = confirmed.current;
        setPendingIndex(confirmed.current);
        setLoadError(failMessage);
      };
      try {
        const response = await authorized(
          `${path.split("?")[0]}/${encodeURIComponent(id)}${query}`
        );
        if (!response.ok) {
          revert();
          return;
        }
        const next = (await response.json()) as CrashDetail;
        if (gen !== fetchGen.current) return;
        requested.current = next.occurrence.index;
        confirmed.current = next.occurrence.index;
        setPendingIndex(next.occurrence.index);
        setDetail(next);
      } catch {
        revert();
      }
    },
    [authorized, path]
  );

  useEffect(() => {
    if (!detail || !payload) return;
    const listed = payload.crashes.find((crash) => crash.id === detail.record.id);
    if (!listed) return;
    const remapped = remapOccurrenceIndex(listed.occurrenceTimes, detail.occurrence.rawPath);
    const index = remapped ?? detail.occurrence.index;
    const total = listed.occurrenceCount;
    if (
      listed.count === detail.record.count &&
      total === detail.occurrence.total &&
      index === detail.occurrence.index
    ) {
      return;
    }
    if (remapped !== null) {
      if (requested.current === detail.occurrence.index) requested.current = remapped;
      if (confirmed.current === detail.occurrence.index) confirmed.current = remapped;
      setPendingIndex((pending) => (pending === detail.occurrence.index ? remapped : pending));
    }
    setDetail((prev) =>
      prev && prev.record.id === listed.id
        ? {
            ...prev,
            record: listed,
            occurrence: { ...prev.occurrence, index, total },
          }
        : prev
    );
  }, [payload, detail]);

  const selectOccurrence = (index: number): void => {
    if (!detail) return;
    if (index < 0 || index >= detail.occurrence.total) return;
    if (index === requested.current) return;
    requested.current = index;
    setPendingIndex(index);
    void loadDetail(detail.record.id, index);
  };

  const stepOccurrence = (delta: number): boolean => {
    const index = (requested.current ?? detail?.occurrence.index ?? 0) + delta;
    if (!detail || index < 0 || index >= detail.occurrence.total) return false;
    if (index === requested.current) return false;
    selectOccurrence(index);
    return true;
  };

  const crashes = payload?.crashes ?? [];
  const unavailable = payload?.meta.status === "unavailable";

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
        <p className="text-[11px] leading-relaxed text-amber-300/80">{payload?.meta.statusError}</p>
      ) : crashes.length === 0 ? (
        <p className="text-[11px] text-white/40">
          No crashes. A report appears a few seconds after the app dies.
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
                  {crash.culpritFrame ?? crash.terminationIndicator ?? "no symbolicated frame"}
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
          loadError={loadError}
          onSelectOccurrence={selectOccurrence}
          onStepOccurrence={stepOccurrence}
          onClose={() => {
            fetchGen.current += 1;
            requested.current = null;
            confirmed.current = null;
            setPendingIndex(null);
            setLoadError(null);
            setDetail(null);
          }}
        />
      )}
    </CollapsibleSection>
  );
}
