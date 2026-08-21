import { useStreamStats } from "../hooks/use-stream-stats";
import type { StreamStats } from "../utils/webrtc-stats";

/**
 * What the receiver can see about stream health. The sender's own reason for degrading
 * (`qualityLimitationReason`) is not in a receive-only browser's stats, so a resolution below the
 * requested one is the closest signal we have that libwebrtc is scaling the picture down.
 */
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

  return (
    <div className="flex flex-col gap-1 font-mono text-[11px] text-white/70">
      <Row label="fps" value={format(stats.fps, 0)} suffix={requestedFps ? ` / ${requestedFps}` : ""} />
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

/** Live readout plus a download of the recorded window, for the stutters nobody is watching for. */
export function StreamStatsSection({
  peerConnection,
  enabled,
  requestedFps,
  requestedMaxDimension,
}: {
  peerConnection: RTCPeerConnection | null;
  enabled: boolean;
  requestedFps?: number;
  requestedMaxDimension?: number;
}) {
  const { stats, history } = useStreamStats(peerConnection, enabled);

  if (stats === null) {
    return <span className="text-[11px] text-white/40">Waiting for the first sample…</span>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <StreamStatsBody
        stats={stats}
        requestedFps={requestedFps}
        requestedMaxDimension={requestedMaxDimension}
      />
      <button
        type="button"
        onClick={() => downloadStats(history)}
        className="self-start rounded px-1.5 py-0.5 text-[11px] text-white/50 hover:bg-white/10 hover:text-white/80"
      >
        Save {history.length} samples
      </button>
    </div>
  );
}

/** Serialize the recorded window so a session can be handed to someone else to read. */
export function statsToJson(history: StreamStats[]): string {
  return JSON.stringify({ recordedAt: new Date().toISOString(), samples: history }, null, 2);
}

function downloadStats(history: StreamStats[]): void {
  const url = URL.createObjectURL(new Blob([statsToJson(history)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `stream-stats-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
