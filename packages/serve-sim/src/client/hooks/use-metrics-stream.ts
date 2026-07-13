import { useEffect, useState } from "react";

// Type-only — the sampler's node: imports must not reach the client bundle.
import type { MetricSample, MetricsMeta } from "../../cpu-mem-sampler";
import { openHostEventStream } from "../utils/exec";

export type { MetricSample, MetricsMeta };

// ~1 minute of history at 1s cadence.
const MAX_POINTS = 60;

// The transport strips SSE `event:` lines, so meta and sample frames both
// arrive as messages — discriminated by shape.
export function useMetricsStream(path: string): {
  meta: MetricsMeta | null;
  latest: MetricSample | null;
  history: MetricSample[];
  errored: boolean;
} {
  const [meta, setMeta] = useState<MetricsMeta | null>(null);
  const [history, setHistory] = useState<MetricSample[]>([]);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    // Reset so a device switch drops the previous device's samples.
    setMeta(null);
    setHistory([]);
    setErrored(false);
    const stream = openHostEventStream(path);
    stream.onmessage = ({ data }) => {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        setErrored(false);
        if ("schemaVersion" in parsed) setMeta(parsed as unknown as MetricsMeta);
        else if ("t" in parsed) {
          setHistory((prev) => [...prev, parsed as unknown as MetricSample].slice(-MAX_POINTS));
        }
      } catch {
        // ignore a malformed frame
      }
    };
    stream.onerror = () => setErrored(true);
    return () => stream.close();
  }, [path]);

  return { meta, latest: history.at(-1) ?? null, history, errored };
}
