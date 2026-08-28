import { Info, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useMetricsStream } from "../hooks/use-metrics-stream";
import { Chevron } from "../icons";
import { formatCpu, formatMem, formatRate, sparklinePath } from "../utils/format-metrics";
import { simEndpoint } from "../utils/sim-endpoint";
import { CollapsibleSection } from "./collapsible-section";
import { SPARK_H, SPARK_W, SparkPath, Sparkline } from "./sparkline";

export function MetricsTool({
  udid,
  currentAppBundleId,
  metricsEndpoint,
}: {
  udid: string;
  currentAppBundleId: string | null;
  metricsEndpoint?: string;
}) {
  const path = useMemo(
    () => metricsEndpoint ?? `${simEndpoint("metrics")}?device=${encodeURIComponent(udid)}`,
    [metricsEndpoint, udid],
  );
  const { meta, latest, history, errored, stale } = useMetricsStream(path);
  const [open, setOpen] = useState(true);
  // Live only while the backend actually scoped to a user app: each sample carries that app's
  // bundleId, and null when a system app is in front (those run outside the sampler's reach) or
  // nothing is running. Keying on the sampler's own output keeps this from drifting from what it can
  // measure; currentAppBundleId (from /appstate) only words the idle reason.
  const live = latest !== null && latest.bundleId !== null && !errored && !stale;
  const foregroundIsSystemApp =
    currentAppBundleId != null && currentAppBundleId.startsWith("com.apple.");
  // When there's nothing to show, a header glyph carries the reason on hover instead of a body line.
  const idleReason = errored
    ? "The metrics stream disconnected"
    : foregroundIsSystemApp
      ? "Only your app is measured; a system app is in the foreground"
      : "Waiting for activity data";
  const fpsStart = history.findIndex((s) => s.fps != null);
  const fpsHistory = fpsStart < 0 ? [] : history.slice(fpsStart);

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      bodyClassName={live ? undefined : "hidden"}
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">
            Activity
          </span>
          {live
            ? !open && (
                <span className="text-[11px] text-white/40 tabular-nums text-right">
                  {formatCpu(latest.cpuPct)} · {formatMem(latest.memBytes)}
                </span>
              )
            : (
                <span
                  data-metrics-warning
                  role="status"
                  className="group relative justify-self-end inline-flex items-center"
                >
                  <TriangleAlert aria-hidden="true" className="w-3.5 h-3.5 text-amber-400" />
                  <span className="sr-only">{idleReason}</span>
                  <span className="pointer-events-none absolute right-0 top-full z-10 mt-1 hidden w-max max-w-[220px] rounded-md bg-black/90 px-2 py-1 text-[11px] leading-snug text-white/90 shadow-lg group-hover:block">
                    {idleReason}
                  </span>
                </span>
              )}
        </>
      }
    >
      {live ? (
        <>
          <MetricRow
            label="CPU"
            value={formatCpu(latest.cpuPct)}
            hint={meta ? `${meta.hostCores} cores` : undefined}
            values={history.map((s) => s.cpuPct)}
            className="text-emerald-400"
          />
          <MetricRow
            label="Memory"
            value={formatMem(latest.memBytes)}
            values={history.map((s) => s.memBytes)}
            className="text-sky-400"
          />
          <NetworkRow
            down={latest.netInBytesPerSec}
            up={latest.netOutBytesPerSec}
            downValues={history.map((s) => s.netInBytesPerSec)}
            upValues={history.map((s) => s.netOutBytesPerSec)}
          />
          {latest.fps != null && (
            <FpsRow
              refresh={latest.mainThreadFps ?? latest.fps}
              rendered={latest.fps}
              refreshValues={fpsHistory.map((s) => s.mainThreadFps ?? 0)}
              renderedValues={fpsHistory.map((s) => s.fps ?? 0)}
            />
          )}
        </>
      ) : null}
    </CollapsibleSection>
  );
}

/** One labeled metric: its current value with a sparkline of recent history. */
function MetricRow({
  label,
  value,
  hint,
  values,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  values: number[];
  className: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-white/50 text-[11px]">{label}</span>
        <span className="tabular-nums text-[11px]">
          {value}
          {hint && <span className="text-white/30 text-[11px] ml-1.5">{hint}</span>}
        </span>
      </div>
      <Sparkline values={values} className={className} />
    </div>
  );
}

function FpsRow({
  refresh,
  rendered,
  refreshValues,
  renderedValues,
}: {
  refresh: number;
  rendered: number;
  refreshValues: number[];
  renderedValues: number[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="border-0 outline-none"
    >
      <summary className="flex cursor-pointer list-none select-none items-center justify-between outline-none [&::-webkit-details-marker]:hidden">
        <span className="group relative inline-flex items-center gap-1 text-white/50 text-[11px]">
          FPS
          <Info aria-hidden="true" className="w-3 h-3 text-white/70" />
          <span className="sr-only">What the FPS lines mean</span>
          <span className="pointer-events-none absolute left-0 bottom-full z-10 mb-1.5 hidden w-max max-w-[220px] rounded-md bg-black/90 px-2.5 py-2 text-[11px] font-normal leading-snug text-white/80 shadow-lg group-hover:block">
            <span className="text-cyan-400 font-medium">Refresh</span> — main-thread render loop rate, tracking the display refresh.
            <br />
            <span className="text-violet-400 font-medium">Rendered</span> — frames the render server composites to the display; near zero when idle.
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="tabular-nums text-[11px]">
            <span className="text-cyan-400">Refresh {Math.round(refresh)}</span>
            <span className="text-white/30 mx-1.5">·</span>
            <span className="text-violet-400">Rendered {Math.round(rendered)}</span>
          </span>
          <Chevron open={open} />
        </span>
      </summary>
      <div className="pt-1">
        <DualFpsSparkline refresh={refreshValues} rendered={renderedValues} />
      </div>
    </details>
  );
}

function DualFpsSparkline({ refresh, rendered }: { refresh: number[]; rendered: number[] }) {
  const max = Math.max(...refresh, ...rendered, 1);
  const refreshLine = sparklinePath(refresh, SPARK_W, SPARK_H, max);
  const refreshArea = refreshLine ? `${refreshLine} L${SPARK_W},${SPARK_H} L0,${SPARK_H} Z` : "";
  return (
    <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" className="w-full h-8">
      <path d={refreshArea} className="text-cyan-400" fill="currentColor" opacity={0.12} stroke="none" />
      <SparkPath d={refreshLine} className="text-cyan-400" />
      <SparkPath d={sparklinePath(rendered, SPARK_W, SPARK_H, max)} className="text-violet-400" />
    </svg>
  );
}

/** Network with download / upload broken out: a value pair and a two-line graph on a shared scale. */
function NetworkRow({
  down,
  up,
  downValues,
  upValues,
}: {
  down: number;
  up: number;
  downValues: number[];
  upValues: number[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-white/50 text-[11px]">Network</span>
        <span className="tabular-nums text-[11px]">
          <span className="text-cyan-400">↓ {formatRate(down)}</span>
          <span className="text-white/30 mx-1.5">·</span>
          <span className="text-violet-400">↑ {formatRate(up)}</span>
        </span>
      </div>
      <DualSparkline down={downValues} up={upValues} />
    </div>
  );
}

/** Two lines (download, upload) on one shared vertical scale so their magnitudes are comparable. */
function DualSparkline({ down, up }: { down: number[]; up: number[] }) {
  const max = Math.max(...down, ...up, 1);
  const downLine = sparklinePath(down, SPARK_W, SPARK_H, max);
  const downArea = downLine ? `${downLine} L${SPARK_W},${SPARK_H} L0,${SPARK_H} Z` : "";
  return (
    <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" className="w-full h-8">
      <path d={downArea} className="text-cyan-400" fill="currentColor" opacity={0.12} stroke="none" />
      <SparkPath d={downLine} className="text-cyan-400" />
      <SparkPath d={sparklinePath(up, SPARK_W, SPARK_H, max)} className="text-violet-400" />
    </svg>
  );
}
