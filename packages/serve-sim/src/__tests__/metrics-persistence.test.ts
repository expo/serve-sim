import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MetricSample, MetricsMeta } from "../cpu-mem-sampler";
import { createMetricsPersistence, udidForArtifactId } from "../metrics-persistence";

const META: MetricsMeta = { schemaVersion: 1, udid: "U", hostCores: 8, sampleIntervalMs: 1000 };
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("udidForArtifactId", () => {
  it("maps metrics-<udid> back to the udid, else null", () => {
    expect(udidForArtifactId("metrics-ABC-123")).toBe("ABC-123");
    expect(udidForArtifactId("recording-ABC")).toBeNull();
  });
});

describe("createMetricsPersistence", () => {
  it("writes a meta header then one line per sample; list reflects file existence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-persist-"));
    const file = join(dir, "m.ndjson");
    try {
      let emit: (s: MetricSample) => void = () => {};
      let unsubscribes = 0;
      const persistence = createMetricsPersistence(
        (_udid, listener) => {
          emit = listener;
          return { meta: META, unsubscribe: () => { unsubscribes += 1; } };
        },
        { filePathFor: () => file },
      );

      expect(persistence.list("U")).toEqual([]); // no file yet

      persistence.ensureStarted("U");
      persistence.ensureStarted("U"); // idempotent — one subscription
      emit({ t: 1000, bundleId: "dev.expo.MyApp", cpuPct: 10, memBytes: 100 });
      emit({ t: 2000, bundleId: "dev.expo.MyApp", cpuPct: 20, memBytes: 200 });
      persistence.stop("U");
      await settle();

      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(JSON.parse(lines[0]!)).toEqual(META);
      expect(JSON.parse(lines[1]!)).toEqual({ t: 1000, bundleId: "dev.expo.MyApp", cpuPct: 10, memBytes: 100 });
      expect(JSON.parse(lines[2]!)).toEqual({ t: 2000, bundleId: "dev.expo.MyApp", cpuPct: 20, memBytes: 200 });
      expect(unsubscribes).toBe(1);

      expect(persistence.list("U")).toEqual([
        { id: "metrics-U", filename: "metrics.ndjson", artifactType: "metrics" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
