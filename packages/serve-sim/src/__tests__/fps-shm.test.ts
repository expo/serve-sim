import { describe, expect, it } from "bun:test";

import {
  decodeFpsShm,
  encodeFpsShm,
  fpsShmName,
  readFpsSample,
  SIMFPS_SHM_SIZE,
} from "../fps-shm";

const bundleId = "dev.expo.MyApp";

function sampleBytes(ageMs: number, bid = bundleId): Uint8Array {
  return encodeFpsShm({
    fps: 54.2,
    mainThreadFps: 60,
    timestampMs: Date.now() - ageMs,
    bundleId: bid,
    maxFps: 60,
  });
}

describe("fpsShmName", () => {
  it("stays under the macOS 31-char POSIX shm limit", () => {
    expect(fpsShmName("AAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE").length).toBeLessThanOrEqual(31);
  });
});

describe("decodeFpsShm / readFpsSample", () => {
  const udid = "FPS-READ-TEST-UDID";

  it("returns the rates when the slot is fresh and the bundle matches", () => {
    const bytes = sampleBytes(0);
    const decoded = decodeFpsShm(bytes, bundleId);
    expect(decoded?.fps).toBeCloseTo(54.2, 5);
    expect(decoded?.mainThreadFps).toBe(60);
    expect(decoded?.maxFps).toBe(60);
    const sample = readFpsSample(udid, bundleId, { copy: () => bytes });
    expect(sample?.fps).toBeCloseTo(54.2, 5);
    expect(sample?.mainThreadFps).toBe(60);
  });

  it("returns null when the sample is older than 2500ms", () => {
    expect(decodeFpsShm(sampleBytes(3000), bundleId)).toBeNull();
  });

  it("returns null when the slot belongs to a different bundle", () => {
    expect(decodeFpsShm(sampleBytes(0, "com.other.App"), bundleId)).toBeNull();
  });

  it("returns null when no bundle is in front or the copy misses", () => {
    expect(readFpsSample(udid, null, { copy: () => sampleBytes(0) })).toBeNull();
    expect(readFpsSample(udid, bundleId, { copy: () => null })).toBeNull();
  });

  it("returns null on a torn seqlock (odd seq)", () => {
    const bytes = encodeFpsShm({
      fps: 54.2,
      mainThreadFps: 60,
      timestampMs: Date.now(),
      bundleId,
      seq: 3,
    });
    expect(decodeFpsShm(bytes, bundleId)).toBeNull();
  });

  it("rejects a short buffer", () => {
    expect(decodeFpsShm(new Uint8Array(SIMFPS_SHM_SIZE - 1), bundleId)).toBeNull();
  });
});
