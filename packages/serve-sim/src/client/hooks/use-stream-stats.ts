import { useEffect, useRef, useState } from "react";

import {
  describeStreamStats,
  readStreamStats,
  type StreamStats,
  type StreamStatsSample,
} from "../utils/webrtc-stats";

const POLL_MS = 1000;

/**
 * Poll a peer connection for the stats that explain a laggy stream.
 *
 * Returns null until two samples exist, because every rate here is a delta.
 */
export function useStreamStats(
  peerConnection: RTCPeerConnection | null,
  enabled: boolean,
): StreamStats | null {
  const [stats, setStats] = useState<StreamStats | null>(null);
  const previousRef = useRef<StreamStatsSample | null>(null);

  useEffect(() => {
    if (!enabled || peerConnection === null) {
      previousRef.current = null;
      setStats(null);
      return;
    }

    let stopped = false;
    const sample = async () => {
      let report: RTCStatsReport;
      try {
        report = await peerConnection.getStats();
      } catch {
        // A closing connection rejects; the next tick either succeeds or the effect is torn down.
        return;
      }
      if (stopped) return;
      const next = readStreamStats(report, Date.now());
      setStats(describeStreamStats(previousRef.current, next));
      previousRef.current = next;
    };

    void sample();
    const timer = window.setInterval(() => void sample(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [peerConnection, enabled]);

  return stats;
}
