import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  deviceLogMatches,
  isDeviceLogError,
  parseDeviceLogJson,
  type DeviceLogFields,
} from "../utils/device-log-format";
import { openHostEventStream } from "../utils/exec";
import { simEndpoint } from "../utils/sim-endpoint";
import { CollapsibleSection } from "./collapsible-section";

const MAX_LOG_ROWS = 400;
const REPLAY_LIMIT = 400;
const NEAR_BOTTOM_PX = 40;

type DisplayLine = DeviceLogFields & { id: number };

export function LogsTool({
  udid,
  logsEndpoint,
}: {
  udid: string;
  logsEndpoint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [lines, setLines] = useState<DisplayLine[]>([]);
  const [errored, setErrored] = useState(false);
  const path = useMemo(() => {
    const base = logsEndpoint ?? `${simEndpoint("logs")}?device=${encodeURIComponent(udid)}`;
    const url = new URL(base, "http://127.0.0.1");
    url.searchParams.set("limit", String(REPLAY_LIMIT));
    return `${url.pathname}${url.search}`;
  }, [logsEndpoint, udid]);

  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const pendingRef = useRef<DisplayLine[]>([]);
  const rafRef = useRef<number | null>(null);
  const nextIdRef = useRef(1);

  useEffect(() => {
    if (!open || paused) return;
    setErrored(false);
    setLines([]);
    nextIdRef.current = 1;
    pendingRef.current = [];
    const stream = openHostEventStream(path);

    const flush = (): void => {
      rafRef.current = null;
      const batch = pendingRef.current;
      if (batch.length === 0) return;
      pendingRef.current = [];
      setLines((prev) => {
        const next = prev.concat(batch);
        return next.length > MAX_LOG_ROWS ? next.slice(next.length - MAX_LOG_ROWS) : next;
      });
    };

    stream.onmessage = ({ data }) => {
      const fields = parseDeviceLogJson(data);
      if (!fields) return;
      pendingRef.current.push({ ...fields, id: nextIdRef.current++ });
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flush);
      }
    };
    stream.onerror = () => setErrored(true);
    return () => {
      stream.close();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      pendingRef.current = [];
    };
  }, [open, paused, path]);

  const visible = useMemo(
    () => (filter.trim() ? lines.filter((line) => deviceLogMatches(line, filter)) : lines),
    [lines, filter]
  );

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [visible]);

  const live = open && !paused && !errored;

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setPaused(false);
      }}
      data-logs=""
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none">
            Logs
          </span>
          <span className="justify-self-end inline-flex items-center gap-1.5">
            {live ? (
              <span className="size-1.5 rounded-full bg-emerald-400" aria-label="Live" />
            ) : null}
            <span className="rounded-md border border-white/8 bg-white/[0.04] px-1.5 py-[3px] text-[10px] font-mono text-white/60">
              {visible.length}
            </span>
          </span>
        </>
      }
    >
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter logs"
          placeholder="Filter"
          className="min-w-0 flex-1 rounded-md border border-white/8 bg-white/[0.04] px-2 py-1 text-[11px] text-white/90 placeholder:text-white/35 outline-none focus:border-white/20"
        />
        <button
          type="button"
          onClick={() => setPaused((value) => !value)}
          className="shrink-0 rounded-md border border-white/8 px-2 py-1 text-[11px] text-white/60 hover:bg-white/[0.06] hover:text-white/80"
        >
          {paused ? "Resume" : "Pause"}
        </button>
      </div>
      {visible.length === 0 ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-center py-4 text-[12px] text-white/45"
        >
          {errored ? "Disconnected" : filter.trim() ? "No matches" : "No log lines yet"}
        </div>
      ) : (
        <div
          ref={listRef}
          role="list"
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
          }}
          className="flex max-h-[320px] flex-col gap-0.5 overflow-y-auto py-0.5 font-mono [scrollbar-width:thin]"
        >
          {visible.map((line) => (
            <LogRow key={line.id} line={line} />
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}

function LogRow({ line }: { line: DisplayLine }) {
  const detail = [line.subsystem, line.category].filter(Boolean).join(":");
  const error = isDeviceLogError(line.level);
  return (
    <div
      role="listitem"
      title={detail ? `${line.process} ${detail}` : line.process}
      className="grid grid-cols-[minmax(0,88px)_1fr] items-baseline gap-2 rounded-md px-1.5 py-0.5 text-[11px] leading-snug hover:bg-white/[0.05]"
    >
      <span className="truncate text-white/40">{line.process || "unknown"}</span>
      <span className={`min-w-0 truncate ${error ? "text-red-300" : "text-white/80"}`}>
        {line.message}
      </span>
    </div>
  );
}
