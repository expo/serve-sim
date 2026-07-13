import { useMemo, useState } from "react";
import { useMetricsStream } from "../hooks/use-metrics-stream";
import { formatCpu, formatMem, sparklinePath } from "../utils/format-metrics";
import { simEndpoint } from "../utils/sim-endpoint";
import { CollapsibleSection } from "./collapsible-section";

const SPARK_W = 96;
const SPARK_H = 24;

// Live CPU/memory readout for the sim's user app, with a sparkline for each.
export function MetricsTool({ udid, metricsEndpoint }: { udid: string; metricsEndpoint?: string }) {
  const path = useMemo(
    () => metricsEndpoint ?? `${simEndpoint("metrics")}?device=${encodeURIComponent(udid)}`,
    [metricsEndpoint, udid],
  );
  const { meta, latest, history, errored } = useMetricsStream(path);
  const [open, setOpen] = useState(true);

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">
            Activity
          </span>
          {!open && latest && (
            <span className="text-[11px] text-white/40 tabular-nums text-right">
              {formatCpu(latest.cpuPct)} · {formatMem(latest.memBytes)}
            </span>
          )}
        </>
      }
    >
      {latest ? (
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
        </>
      ) : (
        <div className="text-white/50 text-[12px]">{errored ? "Disconnected" : "Waiting for CPU / memory…"}</div>
      )}
    </CollapsibleSection>
  );
}

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

function Sparkline({ values, className }: { values: number[]; className: string }) {
  const line = sparklinePath(values, SPARK_W, SPARK_H);
  // Close the line down to the baseline and back to fill the area under it.
  const area = line ? `${line} L${SPARK_W},${SPARK_H} L0,${SPARK_H} Z` : "";
  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      className={`w-full h-8 ${className}`}
    >
      <path d={area} fill="currentColor" opacity={0.12} stroke="none" />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
