import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { dirnameOf } from "./runtime";

const SIMFPS_SHM_MAGIC = 0x53465031;
const SIMFPS_SHM_VERSION = 1;
export const SIMFPS_SHM_SIZE = 128;
const BUNDLE_ID_MAX = 64;
const MAX_AGE_MS = 2500;

export type FpsSample = {
  fps: number;
  mainThreadFps: number;
  timestampMs: number;
  maxFps: number;
};

export function fpsShmName(udid: string): string {
  const short = createHash("sha1").update(udid).digest("hex").slice(0, 8);
  return `/serve-sim-fps-${short}`;
}

export function encodeFpsShm(sample: {
  fps: number;
  mainThreadFps: number;
  timestampMs: number;
  bundleId: string;
  maxFps?: number;
  seq?: number;
}): Uint8Array {
  const buf = new Uint8Array(SIMFPS_SHM_SIZE);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const seq = sample.seq ?? 2;
  view.setUint32(0, SIMFPS_SHM_MAGIC, true);
  view.setUint32(4, SIMFPS_SHM_VERSION, true);
  view.setUint32(8, seq, true);
  view.setFloat32(12, sample.fps, true);
  view.setFloat32(16, sample.mainThreadFps, true);
  view.setUint32(20, sample.maxFps ?? 0, true);
  view.setBigUint64(24, BigInt(sample.timestampMs), true);
  const id = new TextEncoder().encode(sample.bundleId);
  buf.set(id.subarray(0, BUNDLE_ID_MAX - 1), 32);
  view.setUint32(96, seq, true);
  return buf;
}

export function decodeFpsShm(
  bytes: Uint8Array,
  bundleId: string | null,
  now = Date.now(),
): FpsSample | null {
  if (!bundleId || bytes.byteLength < SIMFPS_SHM_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SIMFPS_SHM_MAGIC) return null;
  if (view.getUint32(4, true) !== SIMFPS_SHM_VERSION) return null;
  const seq = view.getUint32(8, true);
  const seqCopy = view.getUint32(96, true);
  if ((seq & 1) !== 0 || seq === 0 || seq !== seqCopy) return null;
  const fps = view.getFloat32(12, true);
  const mainThreadFps = view.getFloat32(16, true);
  const maxFps = view.getUint32(20, true);
  const timestampMs = Number(view.getBigUint64(24, true));
  if (!Number.isFinite(fps) || !Number.isFinite(mainThreadFps) || !Number.isFinite(timestampMs)) {
    return null;
  }
  if (now - timestampMs > MAX_AGE_MS) return null;
  const bidBytes = bytes.subarray(32, 32 + BUNDLE_ID_MAX);
  const end = bidBytes.indexOf(0);
  const bid = new TextDecoder().decode(end < 0 ? bidBytes : bidBytes.subarray(0, end));
  if (bid && bid !== bundleId) return null;
  return { fps, mainThreadFps, timestampMs, maxFps };
}

export function readFpsSample(
  udid: string,
  bundleId: string | null,
  opts?: { now?: number; copy?: (name: string) => Uint8Array | null },
): FpsSample | null {
  if (!bundleId) return null;
  const bytes = (opts?.copy ?? copyFpsShm)(fpsShmName(udid));
  if (!bytes) return null;
  return decodeFpsShm(bytes, bundleId, opts?.now ?? Date.now());
}

const require = createRequire(import.meta.url);

type FpsShmAddon = {
  copy: (name: string) => ArrayBuffer | undefined;
  remove?: (name: string) => boolean;
};

let addonImpl: FpsShmAddon | undefined;

function loadFpsShmAddon(): FpsShmAddon | null {
  if (addonImpl) return addonImpl;
  const here = dirnameOf(import.meta.url);
  const path = [
    join(dirname(process.execPath), "simfps", "fps-shm.node"),
    join(here, "simfps", "fps-shm.node"),
    join(here, "..", "dist", "simfps", "fps-shm.node"),
  ].find((p) => existsSync(p));
  if (!path) return null;
  try {
    addonImpl = require(path) as FpsShmAddon;
    return addonImpl;
  } catch {
    return null;
  }
}

function copyFpsShm(name: string): Uint8Array | null {
  const buf = loadFpsShmAddon()?.copy(name);
  return buf ? new Uint8Array(buf) : null;
}

export function unlinkFpsShm(udid: string): boolean {
  return loadFpsShmAddon()?.remove?.(fpsShmName(udid)) ?? false;
}
