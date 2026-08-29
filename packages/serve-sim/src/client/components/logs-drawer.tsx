import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowDownToLine, Copy, Pause, Play, Trash2, X } from "lucide-react";
import {
  DEVICE_LOG_LEVELS,
  deviceLogMatches,
  formatLogClock,
  formatLogLine,
  type DeviceLogFields,
  type DeviceLogLevel,
} from "../utils/device-log-format";
import { logWindow } from "../utils/logs-window";
import { startLogsPoll } from "../utils/logs-poll";
import { simEndpoint } from "../utils/sim-endpoint";
import { PanelTitle } from "../Panel";
import { PANEL_BACKGROUND } from "./panel-colors";

const MAX_LOG_ROWS = 2000;
const NEAR_BOTTOM_PX = 48;

type DisplayLine = DeviceLogFields & { id: number };

type LevelEnabled = Record<DeviceLogLevel, boolean>;

const DEFAULT_LEVELS: LevelEnabled = {
  debug: false,
  info: true,
  default: true,
  error: true,
  fault: true,
};

export function LogsDrawer({
  open,
  onClose,
  udid,
  logsEndpoint,
  currentAppPid,
  height,
  leftInset,
  rightInset,
  onResizePointerDown,
}: {
  open: boolean;
  onClose: () => void;
  udid: string;
  logsEndpoint?: string;
  currentAppPid?: number | null;
  height: number;
  leftInset: number;
  rightInset: number;
  onResizePointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<"all" | "app">("all");
  const [levels, setLevels] = useState<LevelEnabled>(DEFAULT_LEVELS);
  const [lines, setLines] = useState<DisplayLine[]>([]);
  const [errored, setErrored] = useState(false);
  const [following, setFollowing] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const path = useMemo(
    () => logsEndpoint ?? `${simEndpoint("logs")}?device=${encodeURIComponent(udid)}`,
    [logsEndpoint, udid]
  );

  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const nextIdRef = useRef(1);
  const lastSeqRef = useRef(0);
  const pausedRef = useRef(paused);
  const erroredRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    if (!open) return;
    erroredRef.current = false;
    setErrored(false);
    setLines([]);
    setExpandedId(null);
    nextIdRef.current = 1;
    lastSeqRef.current = 0;
    stickRef.current = true;
    setFollowing(true);
  }, [open, path]);

  useEffect(() => {
    if (!open || paused) return;
    return startLogsPoll(path, {
      getSince: () => lastSeqRef.current,
      setSince: (seq) => {
        if (pausedRef.current) return;
        lastSeqRef.current = seq;
      },
      onBatch: (batch) => {
        if (pausedRef.current) return;
        setLines((prev) => {
          const mapped = batch.map((line) => ({ ...line.fields, id: nextIdRef.current++ }));
          const merged = prev.length === 0 ? mapped : prev.concat(mapped);
          return merged.length > MAX_LOG_ROWS ? merged.slice(merged.length - MAX_LOG_ROWS) : merged;
        });
      },
      onError: (next) => {
        if (erroredRef.current === next) return;
        erroredRef.current = next;
        setErrored(next);
      },
    });
  }, [open, paused, path]);

  useEffect(() => {
    if (!open) setPaused(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (filter.trim()) {
        e.preventDefault();
        setFilter("");
        return;
      }
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, filter]);

  const visible = useMemo(() => {
    const needle = filter.trim();
    const appPid = scope === "app" ? currentAppPid : undefined;
    if (!needle && scope !== "app" && DEVICE_LOG_LEVELS.every((level) => levels[level])) {
      return lines;
    }
    return lines.filter((line) => {
      if (!levels[line.level]) return false;
      if (appPid !== undefined && (appPid == null || line.pid !== appPid)) return false;
      return needle ? deviceLogMatches(line, needle) : true;
    });
  }, [lines, filter, levels, scope, currentAppPid]);

  const live = open && !paused && !errored;
  const appScopeAvailable = currentAppPid != null;

  const jumpToLatest = (): void => {
    stickRef.current = true;
    setFollowing(true);
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const copyVisible = (): void => {
    const text = visible.map(formatLogLine).join("\n");
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {}
    );
  };

  const filteredOut =
    Boolean(filter.trim()) ||
    scope === "app" ||
    DEVICE_LOG_LEVELS.some((level) => !levels[level]);
  const emptyLabel = errored
    ? "Disconnected"
    : scope === "app" && !appScopeAvailable
      ? "No current app"
      : filteredOut
        ? "No matches"
        : "No log lines yet";

  return (
    <aside
      data-logs=""
      aria-hidden={!open}
      aria-label="Device logs"
      className="fixed z-34 flex min-w-0 flex-col overflow-hidden border-t border-white/10 bg-panel-bg text-white/90 shadow-[0_-8px_32px_rgba(0,0,0,0.35)] backdrop-blur-[18px] [font-family:-apple-system,system-ui,sans-serif] [transition:transform_0.25s_ease,opacity_0.2s_ease]"
      style={{
        height,
        left: leftInset,
        right: rightInset,
        bottom: 0,
        backgroundColor: PANEL_BACKGROUND,
        transform: open ? "translateY(0)" : "translateY(100%)",
        opacity: open ? 1 : 0,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize logs drawer"
        onPointerDown={onResizePointerDown}
        className="absolute inset-x-0 top-0 z-10 flex h-3 cursor-row-resize touch-none items-start justify-center pt-1"
      >
        <span className="h-1 w-8 rounded-full bg-white/20" />
      </div>
      <div className="flex shrink-0 items-center gap-2 border-b border-white/8 px-3 py-1.5">
        <PanelTitle>Logs</PanelTitle>
        <span
          className={`size-1.5 shrink-0 rounded-full ${live ? "bg-emerald-400" : "bg-transparent"}`}
          aria-label={live ? "Live" : undefined}
        />
        <span className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md border border-white/8 bg-white/[0.04] px-2 font-mono text-[10px] leading-none text-white/60">
          {visible.length}
        </span>
        <div className="flex h-8 shrink-0 divide-x divide-white/8 overflow-hidden rounded-md border border-white/8">
          <ScopeButton
            pressed={scope === "all"}
            onClick={() => setScope("all")}
            label="All processes"
          >
            All
          </ScopeButton>
          <ScopeButton
            pressed={scope === "app"}
            onClick={() => setScope("app")}
            label="Current app"
            disabled={!appScopeAvailable}
          >
            App
          </ScopeButton>
        </div>
        <div className="ml-auto flex h-8 shrink-0 items-center">
          <IconButton label="Jump to latest" onClick={jumpToLatest} hidden={following}>
            <ArrowDownToLine size={16} strokeWidth={2} />
          </IconButton>
          <IconButton label={copied ? "Copied" : "Copy visible"} onClick={copyVisible}>
            <Copy size={16} strokeWidth={2} />
          </IconButton>
          <IconButton
            label="Clear"
            onClick={() => {
              setLines([]);
              setExpandedId(null);
            }}
          >
            <Trash2 size={16} strokeWidth={2} />
          </IconButton>
          <IconButton
            label={paused ? "Resume" : "Pause"}
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? <Play size={16} strokeWidth={2} /> : <Pause size={16} strokeWidth={2} />}
          </IconButton>
          <IconButton label="Close logs" onClick={onClose}>
            <X size={16} strokeWidth={2} />
          </IconButton>
        </div>
      </div>
      <div className="relative z-20 flex shrink-0 items-center gap-2 overflow-visible border-b border-white/8 px-3 py-1.5">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter logs"
          placeholder="Filter"
          className="box-border h-8 min-h-8 min-w-0 flex-1 appearance-none rounded-md border border-white/8 bg-white/[0.04] px-2.5 text-[11px] leading-none text-white/90 placeholder:text-white/35 outline-none focus:border-white/20"
        />
        <div
          className="flex h-8 shrink-0 overflow-visible rounded-md border border-white/8"
          role="group"
          aria-label="Log levels"
        >
          {DEVICE_LOG_LEVELS.map((level, index) => (
            <LevelButton
              key={level}
              level={level}
              pressed={levels[level]}
              first={index === 0}
              last={index === DEVICE_LOG_LEVELS.length - 1}
              onClick={() => setLevels((prev) => ({ ...prev, [level]: !prev[level] }))}
            />
          ))}
        </div>
      </div>
      {errored && lines.length > 0 ? (
        <p role="status" className="shrink-0 px-3 py-1.5 text-[11px] leading-none text-amber-300/80">
          Disconnected. Reconnecting…
        </p>
      ) : null}
      {visible.length === 0 ? (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-1 items-center justify-center text-[12px] text-white/45"
        >
          {emptyLabel}
        </div>
      ) : (
        <LogList
          listRef={listRef}
          stickRef={stickRef}
          lines={visible}
          expandedId={expandedId}
          onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
          onFollowingChange={setFollowing}
        />
      )}
    </aside>
  );
}

function LogList({
  listRef,
  stickRef,
  lines,
  expandedId,
  onToggle,
  onFollowingChange,
}: {
  listRef: RefObject<HTMLDivElement | null>;
  stickRef: RefObject<boolean>;
  lines: DisplayLine[];
  expandedId: number | null;
  onToggle: (id: number) => void;
  onFollowingChange: (next: boolean) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(120);
  const scrollRaf = useRef<number | null>(null);
  const scrollTopRef = useRef(0);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = (): void => {
      setViewportHeight(el.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [listRef]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
    scrollTopRef.current = el.scrollTop;
    setScrollTop(el.scrollTop);
  }, [lines.length, listRef, stickRef]);

  const expandedIndex = expandedId === null ? null : lines.findIndex((line) => line.id === expandedId);
  const win = logWindow(
    lines.length,
    scrollTop,
    viewportHeight,
    expandedIndex === -1 ? null : expandedIndex
  );
  const slice = lines.slice(win.start, win.end);

  return (
    <div
      ref={listRef}
      role="list"
      onScroll={() => {
        const el = listRef.current;
        if (!el) return;
        scrollTopRef.current = el.scrollTop;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
        if (atBottom !== stickRef.current) {
          stickRef.current = atBottom;
          onFollowingChange(atBottom);
        }
        if (scrollRaf.current === null) {
          scrollRaf.current = requestAnimationFrame(() => {
            scrollRaf.current = null;
            setScrollTop(scrollTopRef.current);
          });
        }
      }}
      className="min-h-0 flex-1 overflow-y-auto px-3 py-1 font-mono contain-strict [scrollbar-width:thin]"
    >
      <div style={{ height: win.total, position: "relative" }}>
        <div style={{ transform: `translateY(${win.padTop}px)` }}>
          {slice.map((line) => (
            <LogRow
              key={line.id}
              line={line}
              expanded={expandedId === line.id}
              onToggle={onToggle}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ScopeButton({
  pressed,
  onClick,
  label,
  disabled,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 items-center border-0 px-2.5 text-[10px] leading-none ${
        pressed ? "bg-white/12 text-white/90" : "bg-transparent text-white/45 hover:text-white/70"
      } disabled:opacity-30 disabled:hover:text-white/45`}
    >
      {children}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  children,
  hidden,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  hidden?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      tabIndex={hidden ? -1 : undefined}
      aria-hidden={hidden || undefined}
      className={`flex h-8 w-8 items-center justify-center rounded-md border-0 bg-transparent p-0 text-[#8e8e93] hover:bg-white/8 hover:text-white ${
        hidden ? "invisible pointer-events-none" : ""
      }`}
    >
      {children}
    </button>
  );
}

function LevelButton({
  level,
  pressed,
  first,
  last,
  onClick,
}: {
  level: DeviceLogLevel;
  pressed: boolean;
  first: boolean;
  last: boolean;
  onClick: () => void;
}) {
  const label = level[0]!.toUpperCase() + level.slice(1);
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={pressed ? `${label}, on` : `${label}, off`}
      onClick={onClick}
      className={`group relative flex h-8 w-8 shrink-0 items-center justify-center border-0 p-0 ${
        first ? "rounded-l-[5px]" : "border-l border-solid border-white/8"
      } ${last ? "rounded-r-[5px]" : ""} ${
        pressed ? "bg-white/14" : "bg-transparent hover:bg-white/[0.06]"
      }`}
    >
      <LevelGlyph level={level} active={pressed} className="size-5" />
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/12 bg-[#181818] px-1.5 py-1 text-[11px] font-medium leading-none text-white/90 opacity-0 shadow-[0_4px_14px_rgba(0,0,0,0.32)] transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        {pressed ? `${label} on` : `${label} off`}
      </span>
    </button>
  );
}

function LevelGlyph({
  level,
  className = "size-4",
  active = true,
}: {
  level: DeviceLogLevel;
  className?: string;
  active?: boolean;
}) {
  const svg = `block shrink-0 ${className}`;
  if (level === "fault") {
    return (
      <svg className={svg} viewBox="0 0 16 16" aria-hidden="true">
        {active ? (
          <>
            <polygon points="8,1.6 13.6,4.8 13.6,11.2 8,14.4 2.4,11.2 2.4,4.8" fill="#f87171" />
            <path d="M8 5.4v3.4M8 11h.01" stroke="#1a0000" strokeWidth="1.35" strokeLinecap="round" />
          </>
        ) : (
          <polygon
            points="8,1.6 13.6,4.8 13.6,11.2 8,14.4 2.4,11.2 2.4,4.8"
            fill="none"
            stroke="#52525b"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        )}
      </svg>
    );
  }
  if (level === "error") {
    return (
      <svg className={svg} viewBox="0 0 16 16" aria-hidden="true">
        {active ? (
          <>
            <polygon points="8,1.4 13.2,12.2 2.8,12.2" fill="#fbbf24" />
            <path d="M8 6.1v3M8 10.8h.01" stroke="#1a1200" strokeWidth="1.35" strokeLinecap="round" />
          </>
        ) : (
          <polygon
            points="8,1.8 13.2,12.4 2.8,12.4"
            fill="none"
            stroke="#52525b"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        )}
      </svg>
    );
  }
  if (level === "info") {
    return (
      <svg className={svg} viewBox="0 0 16 16" aria-hidden="true">
        {active ? (
          <>
            <circle cx="8" cy="8" r="6" fill="#60a5fa" />
            <path d="M8 7.2v3.6M8 5.3h.01" stroke="#0b1a33" strokeWidth="1.35" strokeLinecap="round" />
          </>
        ) : (
          <circle cx="8" cy="8" r="5.4" fill="none" stroke="#52525b" strokeWidth="1.5" />
        )}
      </svg>
    );
  }
  if (level === "debug") {
    return (
      <svg className={svg} viewBox="0 0 16 16" aria-hidden="true">
        {active ? (
          <rect x="3" y="3" width="10" height="10" rx="2" fill="#a1a1aa" />
        ) : (
          <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="2" fill="none" stroke="#52525b" strokeWidth="1.5" />
        )}
      </svg>
    );
  }
  return (
    <svg className={svg} viewBox="0 0 16 16" aria-hidden="true">
      {active ? (
        <circle cx="8" cy="8" r="3.1" fill="#a1a1aa" />
      ) : (
        <circle cx="8" cy="8" r="3.1" fill="none" stroke="#52525b" strokeWidth="1.5" />
      )}
    </svg>
  );
}

const LogRow = memo(function LogRow({
  line,
  expanded,
  onToggle,
}: {
  line: DisplayLine;
  expanded: boolean;
  onToggle: (id: number) => void;
}) {
  const time = formatLogClock(line.timestamp);
  const meta = [line.subsystem, line.category].filter(Boolean).join(":");
  const tone =
    line.level === "fault" || line.level === "error"
      ? "text-red-300"
      : line.level === "debug"
        ? "text-white/40"
        : "text-white/80";
  return (
    <button
      type="button"
      role="listitem"
      onClick={() => onToggle(line.id)}
      aria-expanded={expanded}
      title={meta ? `${line.process} ${meta}` : line.process}
      className={`flex w-full items-start gap-3 text-left hover:bg-white/[0.04] ${
        expanded ? "min-h-[22px] py-0.5" : "h-[22px] items-center overflow-hidden"
      }`}
    >
      <span className="w-[5.5rem] shrink-0 font-mono text-[11px] leading-5 tabular-nums text-white/35">
        {time || "\u00a0"}
      </span>
      <span className="flex h-5 w-6 shrink-0 items-center justify-center">
        <LevelGlyph level={line.level} className="size-4" />
      </span>
      <span className="w-[7.5rem] shrink-0 truncate text-[11px] leading-5 text-white/40">
        {line.process || "unknown"}
      </span>
      <span className="min-w-0 flex-1 text-[11px] leading-5">
        <span className={`block ${expanded ? "whitespace-pre-wrap break-all" : "truncate"} ${tone}`}>
          {line.message}
        </span>
        {expanded ? (
          <span className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] leading-4 text-white/35">
            {line.pid !== null && <span>pid {line.pid}</span>}
            {line.library !== "" && line.library !== line.process && <span>{line.library}</span>}
            {meta !== "" && <span>{meta}</span>}
          </span>
        ) : null}
      </span>
    </button>
  );
});
