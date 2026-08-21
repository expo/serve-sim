import { useState } from "react";

import { useStreamStats } from "../hooks/use-stream-stats";
import type { StreamStats } from "../utils/webrtc-stats";
import { CollapsibleSection } from "./collapsible-section";

/**
 * What the receiver can see about stream health. The sender's own reason for degrading
 * (`qualityLimitationReason`) is not in a receive-only browser's stats, so a resolution below the
 * requested one is the closest signal we have that libwebrtc is scaling the picture down.
 */
export function StreamStatsTool({
  peerConnection,
  requestedFps,
  requestedMaxDimension,
}: {
  peerConnection: RTCPeerConnection | null;
  requestedFps?: number;
  requestedMaxDimension?: number;
}) {
  const [open, setOpen] = useState(false);
  const stats = useStreamStats(peerConnection, open);

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      summary={
        <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none">
          Stream
        </span>
      }
    >
      {stats === null
        ? <span className="text-[11px] text-white/40">Waiting for the first sample…</span>
        : <StreamStatsBody
            stats={stats}
            requestedFps={requestedFps}
            requestedMaxDimension={requestedMaxDimension}
          />}
    </CollapsibleSection>
  );
}

export function StreamStatsBody({
  stats,
  requestedFps,
  requestedMaxDimension,
}: {
  stats: StreamStats;
  requestedFps?: number;
  requestedMaxDimension?: number;
}) {
  const scaledDown = isScaledDown(stats, requestedMaxDimension);
  const belowFps = requestedFps !== undefined && stats.fps !== null && stats.fps < requestedFps * 0.8;

  return (
    <div className="flex flex-col gap-1 font-mono text-[11px] text-white/70">
      <Row label="fps" value={format(stats.fps, 0)} warn={belowFps} suffix={requestedFps ? ` / ${requestedFps}` : ""} />
      <Row label="bitrate" value={format(stats.kbps, 0)} suffix=" kbps" />
      <Row
        label="size"
        value={stats.width === null || stats.height === null ? "—" : `${stats.width}x${stats.height}`}
        warn={scaledDown}
        suffix={scaledDown ? " (scaled down)" : ""}
      />
      <Row label="path" value={stats.path} warn={stats.path === "relay"} />
      <Row label="rtt" value={format(stats.roundTripMs, 0)} suffix=" ms" />
      <Row label="jitter" value={format(stats.jitterMs, 1)} suffix=" ms" />
      <Row label="buffer" value={format(stats.jitterBufferMs, 0)} suffix=" ms" />
      <Row
        label="loss"
        value={stats.lossRatio === null ? "—" : (stats.lossRatio * 100).toFixed(1)}
        warn={stats.lossRatio !== null && stats.lossRatio > 0.02}
        suffix="%"
      />
      <Row label="dropped" value={String(stats.droppedInWindow)} warn={stats.droppedInWindow > 0} />
      <Row
        label="freezes"
        value={String(stats.freezesInWindow)}
        warn={stats.freezesInWindow > 0}
        suffix={stats.freezeMs > 0 ? ` (${(stats.freezeMs / 1000).toFixed(1)}s total)` : ""}
      />
      <Row label="codec" value={stats.codec ?? "—"} />
    </div>
  );
}

/** Whether libwebrtc is sending a smaller picture than was asked for. */
export function isScaledDown(stats: StreamStats, requestedMaxDimension?: number): boolean {
  if (requestedMaxDimension === undefined) return false;
  if (stats.width === null || stats.height === null) return false;
  return Math.max(stats.width, stats.height) < requestedMaxDimension;
}

function format(value: number | null, digits: number): string {
  return value === null ? "—" : value.toFixed(digits);
}

function Row({
  label,
  value,
  suffix = "",
  warn = false,
}: {
  label: string;
  value: string;
  suffix?: string;
  warn?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-white/40">{label}</span>
      <span className={warn ? "text-warning" : undefined}>
        {value}
        {suffix}
      </span>
    </div>
  );
}
