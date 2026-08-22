import { triggerBrowserDownload } from "../utils/screenshot-capture";
import type { StreamStats } from "../utils/webrtc-stats";
import { Sparkline } from "./sparkline";

export function StreamStatsBody({
  stats,
  history,
  faults,
  requestedFps,
}: {
  stats: StreamStats;
  history: StreamStats[];
  faults: string[];
  requestedFps?: number;
}) {

  return (
    <div className="flex flex-col gap-2">
      <Graph
        label="Frame rate"
        value={fps(stats.fps)}
        hint={requestedFps ? `of ${requestedFps}` : undefined}
        values={measured(history, (sample) => sample.fps)}
        max={requestedFps}
        className="text-emerald-400"
      />
      <Graph
        label="Bitrate"
        value={bitrate(stats.kbps)}
        values={measured(history, (sample) => sample.kbps)}
        className="text-sky-400"
      />

      {faults.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {faults.map((fault) => (
            <div key={fault} className="text-[11px] text-warning" data-stream-fault={fault}>
              {fault}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-white/30">
          {measurable(stats) ? "No drops, freezes or loss in this window" : "Measuring…"}
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 border-t border-white/10 pt-1.5">
        <Cell label="Round trip" value={ms(stats.roundTripMs, 0)} />
        <Cell label="Jitter" value={ms(stats.jitterMs, 1)} />
        <Cell label="Buffer" value={ms(stats.jitterBufferMs, 0)} />
        <Cell
          label="Resolution"
          value={stats.width === null || stats.height === null
            ? DASH
            : `${stats.width}x${stats.height}`}
        />
        {stats.path !== "unknown" && (
          <Cell label="Route" value={stats.path === "relay" ? "Via relay" : "Direct"} />
        )}
      </div>
    </div>
  );
}

const DASH = "—";

/** Only the windows that produced a reading, so a gap is a gap rather than a drop to zero. */
function measured(history: StreamStats[], pick: (sample: StreamStats) => number | null): number[] {
  const values: number[] = [];
  for (const sample of history) {
    const value = pick(sample);
    if (value !== null) values.push(value);
  }
  return values;
}

/** Whether this sample came from a usable window. Nothing measured is not the same as nothing wrong. */
function measurable(stats: StreamStats): boolean {
  return stats.droppedInWindow !== null;
}

/** For the collapsed section header. */
export function summariseStream(stats: StreamStats): string | null {
  if (stats.fps === null) return null;
  return `${fps(stats.fps)} · ${bitrate(stats.kbps)}`;
}

/** Only faults, so a healthy stream stays quiet. */
export function describeFaults(stats: StreamStats): string[] {
  const faults: string[] = [];
  if (stats.freezesInWindow) {
    const seconds = stats.freezeMsInWindow ? ` (${(stats.freezeMsInWindow / 1000).toFixed(1)}s)` : "";
    faults.push(`${stats.freezesInWindow} freeze${stats.freezesInWindow === 1 ? "" : "s"}${seconds}`);
  }
  if (stats.droppedInWindow) faults.push(`${stats.droppedInWindow} frames dropped`);
  if (stats.lossRatio !== null && stats.lossRatio > 0.02) {
    faults.push(`${(stats.lossRatio * 100).toFixed(1)}% packet loss`);
  }
  return faults;
}

/** One decimal under 10, so a stream limping at 0.4 fps does not read as 0. */
function fps(value: number | null): string {
  if (value === null) return DASH;
  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)} fps`;
}

/** kbps below 1 Mbps, so a limping stream is not "0.00 Mbps". */
function bitrate(kbps: number | null): string {
  if (kbps === null) return DASH;
  return kbps < 1000 ? `${kbps.toFixed(0)} kbps` : `${(kbps / 1000).toFixed(2)} Mbps`;
}

function ms(value: number | null, digits: number): string {
  return value === null ? DASH : `${value.toFixed(digits)} ms`;
}

function Graph({
  label,
  value,
  hint,
  values,
  max,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  values: number[];
  max?: number;
  className: string;
}) {
  return (
    <div className="flex flex-col gap-1" data-stream-stat={label}>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] text-white/50">{label}</span>
        <span className="tabular-nums text-[11px]">
          {value}
          {hint && <span className="ml-1.5 text-[11px] text-white/30">{hint}</span>}
        </span>
      </div>
      <Sparkline values={values} max={max} className={className} />
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2" data-stream-stat={label}>
      <span className="text-[11px] text-white/50">{label}</span>
      <span className="tabular-nums text-[11px] text-white/90">{value}</span>
    </div>
  );
}

export function StreamStatsSection({
  stats,
  history,
  faults,
  requestedFps,
  transport,
}: {
  stats: StreamStats | null;
  history: StreamStats[];
  faults: string[];
  requestedFps?: number;
  transport?: string;
}) {
  if (stats === null) return null;
  return (
    <div className="flex flex-col gap-2">
      <StreamStatsBody
        stats={stats}
        history={history}
        faults={faults}
        requestedFps={requestedFps}
      />
      <button
        type="button"
        disabled={history.length < 2}
        aria-label="Download stream statistics as JSON"
        onClick={() => downloadStats(history, { transport, codec: stats.codec })}
        className="min-h-[24px] cursor-pointer self-start rounded px-1.5 py-0.5 text-[11px] text-white/50 hover:bg-white/10 hover:text-white/80 disabled:cursor-default disabled:opacity-40"
      >
        Download JSON
        <span className="ml-1.5 text-white/30">{history.length}</span>
      </button>
    </div>
  );
}

export interface StatsContext {
  transport?: string;
  codec?: string | null;
}

/** Serialize the recorded window so a session can be handed to someone else to read. */
export function statsToJson(history: StreamStats[], context: StatsContext = {}): string {
  return JSON.stringify(
    { recordedAt: new Date().toISOString(), ...context, samples: history },
    null,
    2,
  );
}

function downloadStats(history: StreamStats[], context: StatsContext): void {
  const url = URL.createObjectURL(
    new Blob([statsToJson(history, context)], { type: "application/json" }),
  );
  triggerBrowserDownload(url, `serve-sim-stream-stats-${timestampSlug()}.json`);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
}
