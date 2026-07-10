// Tees the shared sampler to an NDJSON file (meta line, then one sample per line);
// the EAS poller fetches it at session teardown.

import { createWriteStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MetricSample, MetricsSubscription } from "./cpu-mem-sampler";

const METRICS_DIR = join(tmpdir(), "serve-sim");

export function metricsFilePath(udid: string): string {
  return join(METRICS_DIR, `metrics-${udid}.ndjson`);
}

// Inventory shape the EAS artifact poller expects (argent/agent-device parity).
export interface MetricsArtifact {
  id: string;
  filename: string;
  artifactType: string;
}

const ARTIFACT_ID_PREFIX = "metrics-";

export function udidForArtifactId(id: string): string | null {
  return id.startsWith(ARTIFACT_ID_PREFIX) ? id.slice(ARTIFACT_ID_PREFIX.length) : null;
}

export interface MetricsPersistence {
  ensureStarted: (udid: string) => void;
  list: (udid: string) => MetricsArtifact[];
  filePath: (udid: string) => string;
  stop: (udid: string) => void;
}

export function createMetricsPersistence(
  subscribe: (udid: string, listener: (sample: MetricSample) => void) => MetricsSubscription,
  options: { filePathFor?: (udid: string) => string } = {},
): MetricsPersistence {
  const filePathFor = options.filePathFor ?? metricsFilePath;
  const active = new Map<string, () => void>();

  return {
    ensureStarted(udid) {
      if (active.has(udid)) return;
      const stream = createWriteStream(filePathFor(udid), { flags: "w" });
      const subscription = subscribe(udid, (sample) => {
        stream.write(JSON.stringify(sample) + "\n");
      });
      // A filesystem error must not crash the preview server; drop the writer.
      stream.on("error", () => {
        subscription.unsubscribe();
        active.delete(udid);
      });
      stream.write(JSON.stringify(subscription.meta) + "\n");
      active.set(udid, () => {
        subscription.unsubscribe();
        stream.end();
      });
    },

    list(udid) {
      return existsSync(filePathFor(udid))
        ? [{ id: `${ARTIFACT_ID_PREFIX}${udid}`, filename: "metrics.ndjson", artifactType: "metrics" }]
        : [];
    },

    filePath: filePathFor,

    stop(udid) {
      const close = active.get(udid);
      if (close) {
        close();
        active.delete(udid);
      }
    },
  };
}
