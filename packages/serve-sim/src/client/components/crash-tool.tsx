import { useCallback, useEffect, useMemo, useState } from "react";
import type { CrashSummary } from "../../crash/store";
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

/** Recency is what you want mid-session; the exact clock time stays on hover. */
function agoOf(record: CrashSummary, now: number): string {
  if (record.capturedAtMs === null) return "";
  const seconds = Math.max(0, Math.round((now - record.capturedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function clockOf(record: CrashSummary): string {
  if (record.capturedAtMs === null) return record.capturedAt ?? "";
  return new Date(record.capturedAtMs).toLocaleTimeString();
}

export function CrashTool({ udid, crashesEndpoint }: { udid: string; crashesEndpoint?: string }) {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<CrashListPayload | null>(null);
  const [detail, setDetail] = useState<CrashDetail | null>(null);
  const [now, setNow] = useState(() => Date.now());

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
    const load = async (): Promise<void> => {
      try {
        const response = await authorized(path);
        if (!response.ok || cancelled) return;
        setPayload((await response.json()) as CrashListPayload);
      } catch {
        // A dropped poll is not worth surfacing; the next one recovers.
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [path, authorized]);

  const loadDetail = async (id: string, occurrence?: number): Promise<void> => {
    const query = occurrence === undefined ? "" : `?occurrence=${occurrence}`;
    try {
      const response = await authorized(
        `${path.split("?")[0]}/${encodeURIComponent(id)}${query}`
      );
      if (!response.ok) return;
      setDetail((await response.json()) as CrashDetail);
    } catch {
      // Leave the panel as it was rather than opening an empty dialog.
    }
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
                onClick={() => void loadDetail(crash.id)}
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
                    title={clockOf(crash)}
                    className="ml-auto shrink-0 font-mono text-[10px] text-white/35"
                  >
                    {agoOf(crash, now)}
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
          onSelectOccurrence={(index) => void loadDetail(detail.record.id, index)}
          onClose={() => setDetail(null)}
        />
      )}
    </CollapsibleSection>
  );
}
