import { useEffect, useRef, useState } from "react";

import {
  describeStreamStats,
  readStreamStats,
  type StreamStats,
  type StreamStatsSample,
} from "../utils/webrtc-stats";

const POLL_MS = 1000;
/** ~10 minutes at one sample a second. */
const HISTORY_LIMIT = 600;

// Records while the tools panel is mounted. The first sample has no window behind it, so its rates
// and counts are null.
export function useStreamStats(
  peerConnection: RTCPeerConnection | null,
): { stats: StreamStats | null; history: StreamStats[] } {
  const [stats, setStats] = useState<StreamStats | null>(null);
  const [history, setHistory] = useState<StreamStats[]>([]);
  const previousRef = useRef<StreamStatsSample | null>(null);

  useEffect(() => {
    // Reset unconditionally: a transport retry or codec change swaps the connection object without
    // ever passing through null, and diffing across that boundary reports a dead stream.
    previousRef.current = null;
    if (peerConnection === null) {
      setStats(null);
      setHistory([]);
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
      const described = describeStreamStats(previousRef.current, next);
      setStats(described);
      setHistory((entries) => [...entries, described].slice(-HISTORY_LIMIT));
      previousRef.current = next;
    };

    void sample();
    const timer = window.setInterval(() => void sample(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [peerConnection]);

  return { stats, history };
}
