import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { e2eDevice, requireE2E } from "./e2e-preconditions";

const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");
const FIXTURE = join(PKG_DIR, "dist/capability-loader/ServeSimMicFixture.app");
const DYLIB = join(PKG_DIR, "dist/simmic/libSimMicInjector.dylib");
const APP = "dev.expo.serve-sim.mic-fixture";

const udid = e2eDevice();
const ready = udid !== null && existsSync(CLI) && existsSync(FIXTURE) && existsSync(DYLIB);

requireE2E("serve-sim mic", ready);

const dir = mkdtempSync(join(tmpdir(), "serve-sim-mic-e2e-"));
const sineWav = join(dir, "sine.wav");

function simctl(args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

function cli(args: string[]): any {
  const out = execFileSync("node", [CLI, "mic", ...args, "-d", udid!, "-q"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return JSON.parse(out.trim().split("\n").pop()!);
}

interface Level { mode: string; rms: number }

function levels(): { started: boolean; errors: string[]; levels: Level[] } {
  try {
    const container = simctl(["get_app_container", udid!, APP, "data"]).trim();
    const lines = readFileSync(join(container, "Documents/levels.tsv"), "utf-8").split("\n").filter(Boolean);
    const rows = lines.map((line) => line.split("\t"));
    return {
      started: rows.some((r) => r[0] === "start"),
      errors: rows.filter((r) => r[0] === "error").map((r) => r[2] ?? ""),
      levels: rows.filter((r) => r[0] === "level").map((r) => ({ mode: r[1]!, rms: Number(r[2]) })),
    };
  } catch {
    return { started: false, errors: [], levels: [] };
  }
}

async function waitFor(check: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function clearLevels(): void {
  try {
    const container = simctl(["get_app_container", udid!, APP, "data"]).trim();
    rmSync(join(container, "Documents/levels.tsv"), { force: true });
  } catch {}
}

/** 1.5 s of a 440 Hz sine at amplitude 0.5, 16-bit 44.1 kHz mono. */
function writeSine(path: string): void {
  const rate = 44_100;
  const frames = Math.round(rate * 1.5);
  const data = Buffer.alloc(frames * 2);
  for (let f = 0; f < frames; f++) {
    data.writeInt16LE(Math.round(0.5 * Math.sin((2 * Math.PI * 440 * f) / rate) * 32767), f * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

beforeAll(() => {
  if (!ready) return;
  writeSine(sineWav);
  try { simctl(["uninstall", udid!, APP]); } catch {}
  simctl(["install", udid!, FIXTURE]);
}, 120_000);

afterAll(() => {
  if (ready) {
    try { cli(["off"]); } catch {}
    try { simctl(["uninstall", udid!, APP]); } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
}, 120_000);

describe.skipIf(!ready)("serve-sim mic", () => {
  for (const mode of ["engine", "queue", "vpio"]) {
    test(`${mode}: the app hears silence, then the played clip, then silence`, async () => {
      simctl(["spawn", udid!, "defaults", "write", APP, "mode", mode]);
      clearLevels();
      const launched = cli([APP]);
      expect(launched.bundleId).toBe(APP);
      expect(launched.pid).toBeGreaterThan(0);

      expect(await waitFor(() => levels().levels.length >= 2, 30_000)).toBe(true);
      expect(levels().errors).toEqual([]);
      // Idle mode is silence: the host microphone does not leak through.
      expect(levels().levels.slice(-2).every((l) => l.mode === mode && l.rms === 0)).toBe(true);

      const before = levels().levels.length;
      const played = cli(["play", sineWav, "--wait"]);
      expect(played.ok).toBe(true);
      expect(played.playing).toBe(false);
      expect(played.durationMs).toBeCloseTo(1500, -2);

      const after = levels().levels.length;
      const during = levels().levels.slice(before, after).map((l) => l.rms);
      // Amplitude 0.5 sine → RMS 0.354 in the windows the clip fills.
      expect(during.filter((rms) => Math.abs(rms - 0.354) < 0.03).length).toBeGreaterThanOrEqual(3);

      // The reader trails the writer by 100 ms, so skip one window.
      expect(await waitFor(() => levels().levels.length >= after + 3, 5_000)).toBe(true);
      expect(levels().levels.slice(after + 1).every((l) => l.rms === 0)).toBe(true);
    }, 90_000);
  }

  test("say speaks text into the app and stop cuts a clip short", async () => {
    clearLevels();
    expect(await waitFor(() => levels().levels.length >= 2, 10_000)).toBe(true);
    const spoken = cli(["say", "add milk to my shopping list", "--wait"]);
    expect(spoken.ok).toBe(true);
    expect(levels().levels.some((l) => l.rms > 0.01)).toBe(true);

    cli(["play", sineWav]);
    const stopped = cli(["stop"]);
    expect(stopped.playing).toBe(false);
    const status = cli(["status"]);
    expect(status).toMatchObject({ alive: true, playing: false, bundleIds: [APP] });
  }, 60_000);

  test("off stops the helper and terminates the injected app", () => {
    const result = cli(["off"]);
    expect(result).toMatchObject({ stopped: true, terminated: [APP] });
    expect(cli(["status"]).alive).toBe(false);
  });
});
