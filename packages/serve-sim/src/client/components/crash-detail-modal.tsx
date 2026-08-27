import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { CrashOccurrence, CrashSummary } from "../../crash/store";

/** Raw device-log lines are NDJSON; a reader wants the message, not the envelope. */
function messageOf(raw: string): string {
  try {
    const entry = JSON.parse(raw) as { eventMessage?: unknown };
    return typeof entry.eventMessage === "string" ? entry.eventMessage : raw;
  } catch {
    return raw;
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2">
      <span className="text-[10px] uppercase tracking-[0.08em] text-white/35">{label}</span>
      <span className="font-mono text-[11px] break-all text-white/70">{value}</span>
    </div>
  );
}

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string): void => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return [copied, copy];
}

export type SelectedOccurrence = CrashOccurrence & { index: number; total: number };

export function CrashDetailModal({
  record,
  occurrence,
  report,
  reportError,
  onSelectOccurrence,
  onClose,
}: {
  record: CrashSummary;
  occurrence: SelectedOccurrence;
  report: string | null;
  reportError: string | null;
  onSelectOccurrence: (index: number) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"stack" | "log">("stack");
  const [copied, copy] = useCopy();
  const older = occurrence.index - 1;
  const newer = occurrence.index + 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && older >= 0) onSelectOccurrence(older);
      if (e.key === "ArrowRight" && newer < occurrence.total) onSelectOccurrence(newer);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, onSelectOccurrence, older, newer, occurrence.total]);

  // The route needs a bearer token, so the file is fetched into memory and saved from there
  // rather than linked directly.
  const download = (): void => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([report], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = occurrence.rawPath.split("/").pop() ?? `${record.id}.ips`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const when =
    occurrence.capturedAtMs === null ? occurrence.capturedAt : new Date(occurrence.capturedAtMs);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Crash report"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-[min(720px,90vw)] flex-col rounded-[12px] bg-panel border border-white/12 shadow-[0_16px_48px_rgba(0,0,0,0.6)]"
      >
        <header className="flex items-start justify-between gap-3 border-b border-white/8 px-4 py-3">
          <div>
            <p className="flex items-center gap-2">
              <span className="font-mono text-[13px] text-red-300">
                {record.signal ?? record.exceptionType}
              </span>
              {record.count > 1 && (
                <span className="rounded border border-red-400/30 px-1 text-[10px] font-mono text-red-300">
                  ×{record.count}
                </span>
              )}
              <span className="text-[13px] text-white/80">{record.appName}</span>
            </p>
            <p className="mt-0.5 text-[11px] text-white/40">
              {when instanceof Date ? when.toLocaleString() : (when ?? "unknown time")}
              {occurrence.pid !== null && <span className="text-white/25"> · pid {occurrence.pid}</span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={download}
              disabled={!report}
              className="rounded-md border border-white/12 px-2 py-1 text-[11px] text-white/70 hover:bg-white/8 disabled:opacity-40"
            >
              Download .ips
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md px-2 py-1 text-[13px] text-white/50 hover:bg-white/8"
            >
              ✕
            </button>
          </div>
        </header>

        {occurrence.total > 1 && (
          <div className="flex items-center gap-2 border-b border-white/8 px-4 py-2">
            <button
              type="button"
              disabled={older < 0}
              onClick={() => onSelectOccurrence(older)}
              className="rounded-md border border-white/12 px-2 py-0.5 text-[11px] text-white/70 hover:bg-white/8 disabled:opacity-30"
            >
              ← Older
            </button>
            <span className="flex-1 text-center font-mono text-[11px] text-white/45">
              {occurrence.index + 1} of {occurrence.total}
              {record.count > occurrence.total && (
                <span className="text-white/25"> (last {occurrence.total} of {record.count})</span>
              )}
            </span>
            <button
              type="button"
              disabled={newer >= occurrence.total}
              onClick={() => onSelectOccurrence(newer)}
              className="rounded-md border border-white/12 px-2 py-0.5 text-[11px] text-white/70 hover:bg-white/8 disabled:opacity-30"
            >
              Newer →
            </button>
          </div>
        )}

        <div className="flex flex-col gap-2 border-b border-white/8 px-4 py-3">
          <Row label="Bundle" value={record.bundleId ?? "unknown"} />
          <Row
            label="Seen"
            value={`first ${new Date(record.firstSeen).toLocaleTimeString()} · last ${new Date(record.lastSeen).toLocaleTimeString()} · ${record.count}×`}
          />
          <Row label="Exception" value={`${record.exceptionType ?? "?"} · ${record.terminationIndicator ?? "?"}`} />
          <Row label="Thread" value={record.faultingQueue ?? "unknown queue"} />
          <Row label="Version" value={`${record.appVersion ?? "?"} (${record.buildVersion ?? "?"})`} />
          <Row label="Report" value={occurrence.rawPath} />
          <Row label="Grouped by" value={record.signature} />
        </div>

        <nav className="flex items-center gap-1 px-4 pt-3">
          {(["stack", "log"] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`rounded-md px-2 py-1 text-[11px] ${
                tab === id ? "bg-white/10 text-white/90" : "text-white/45 hover:bg-white/5"
              }`}
            >
              {id === "stack" ? `Stack (${record.frames.length})` : `Log tail (${occurrence.logTail.length})`}
            </button>
          ))}
          <button
            type="button"
            onClick={() =>
              copy(
                tab === "stack"
                  ? record.frames
                      .map((f, i) => `${i}\t${f.image}\t${f.symbol ?? `+${f.imageOffset ?? 0}`}`)
                      .join("\n")
                  : occurrence.logTail.map(messageOf).join("\n")
              )
            }
            className="ml-auto rounded-md px-2 py-1 text-[11px] text-white/45 hover:bg-white/5"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </nav>

        <div className="flex-1 overflow-auto px-4 py-3">
          {reportError && <p className="mb-2 text-[11px] text-amber-300/80">{reportError}</p>}
          {tab === "stack" ? (
            record.frames.length === 0 ? (
              <p className="text-[11px] text-white/35">No symbolicated frames in this report.</p>
            ) : (
              <ol className="flex flex-col gap-0.5">
                {record.frames.map((frame, index) => (
                  <li
                    key={index}
                    className={`grid grid-cols-[24px_140px_1fr] gap-2 font-mono text-[10px] ${
                      frame.appOwned ? "text-white/75" : "text-white/35"
                    }`}
                  >
                    <span className="text-white/25">{index}</span>
                    <span className="truncate">{frame.image}</span>
                    <span className="break-all">{frame.symbol ?? `+${frame.imageOffset ?? 0}`}</span>
                  </li>
                ))}
              </ol>
            )
          ) : occurrence.logTail.length === 0 ? (
            <p className="text-[11px] text-white/35">
              No log lines were captured for this crash ({occurrence.logTailSource}).
            </p>
          ) : (
            <ol className="font-mono text-[10px] leading-relaxed">
              {occurrence.logTail.map((raw, index) => {
                const last = index === occurrence.logTail.length - 1;
                return (
                  <li
                    key={index}
                    className={`grid grid-cols-[34px_1fr] gap-2 rounded px-1 ${
                      last ? "bg-red-400/10 text-white/80" : "text-white/55"
                    }`}
                  >
                    <span className="select-none text-right text-white/25 tabular-nums">
                      {index + 1}
                    </span>
                    <span className="whitespace-pre-wrap break-all">{messageOf(raw)}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
