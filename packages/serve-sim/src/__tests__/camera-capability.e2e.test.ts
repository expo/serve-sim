import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { clearLaunchState, armTrampoline, isCapabilityEnabled, removeTrampolineSync } from "../launch-manager";
import { e2eDevice, readInsert, requireE2E } from "./e2e-preconditions";

const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");
const FIXTURE = join(PKG_DIR, "dist/trampoline/ServeSimLaunchFixture.app");
const APP = "dev.expo.serve-sim.launch-fixture";
const SECOND_APP = "dev.expo.serve-sim.camera-second";
const udid = e2eDevice();
const ready = udid !== null && existsSync(CLI) && existsSync(FIXTURE);
const scratch = mkdtempSync(join(tmpdir(), "serve-sim-camera-lifecycle-"));
requireE2E("camera lifecycle", ready);

function simctl(args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
}
function cli(args: string[]): string {
  return execFileSync("node", [CLI, "camera", ...args, "-d", udid!, "--quiet"], {
    encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  });
}
function lines(app: string, kind: string): string[] {
  const container = simctl(["get_app_container", udid!, app, "data"]).trim();
  const path = join(container, "Documents/launches.tsv");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter((line) => line.startsWith(`${kind}\t`));
}
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(100);
  expect(check()).toBe(true);
}
function springboardPid(): string {
  const entry = simctl(["spawn", udid!, "launchctl", "list"]).split("\n")
    .find((line) => line.endsWith("\tcom.apple.SpringBoard"));
  const pid = entry?.split("\t")[0] ?? "";
  expect(pid).toMatch(/^\d+$/);
  return pid;
}
function image(name: string, red: number, blue: number): string {
  const bmp = Buffer.alloc(54 + 48);
  bmp.write("BM"); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(4, 18); bmp.writeInt32LE(4, 22);
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(48, 34);
  for (let i = 54; i < bmp.length; i += 3) { bmp[i] = blue; bmp[i + 2] = red; }
  const path = join(scratch, name); writeFileSync(path, bmp); return path;
}
const red = image("red.bmp", 255, 0);
const blue = image("blue.bmp", 0, 255);

beforeAll(async () => {
  if (!ready) return;
  cli(["disable"]);
  removeTrampolineSync(udid!);
  clearLaunchState(udid!);
  const second = join(scratch, "Second.app");
  cpSync(FIXTURE, second, { recursive: true });
  execFileSync("plutil", ["-replace", "CFBundleIdentifier", "-string", SECOND_APP, join(second, "Info.plist")]);
  execFileSync("codesign", ["--force", "--sign", "-", second], { stdio: "ignore" });
  for (const [app, bundle] of [[APP, FIXTURE], [SECOND_APP, second]]) {
    try { simctl(["uninstall", udid!, app!]); } catch {}
    simctl(["install", udid!, bundle!]);
  }
  await armTrampoline(udid!);
}, 120_000);

afterAll(() => {
  if (ready) {
    try { cli(["disable"]); } finally { removeTrampolineSync(udid!); clearLaunchState(udid!); }
    for (const app of [APP, SECOND_APP]) {
      try { simctl(["uninstall", udid!, app]); } catch {}
    }
    expect(readInsert(udid!)).toBe("");
  }
  rmSync(scratch, { recursive: true, force: true });
}, 120_000);

describe.skipIf(!ready)("device-wide camera lifecycle", () => {
  test("enable from the home screen leaves SpringBoard and permissions alone", async () => {
    const pid = springboardPid();
    cli(["enable", "--file", red]);
    await Bun.sleep(1000);
    expect(springboardPid()).toBe(pid);
    expect(isCapabilityEnabled(udid!, "camera")).toBe(true);
    cli(["disable"]);
    expect(readInsert(udid!)).toContain("libServeSimTrampoline.dylib");
  }, 30_000);

  test("two running apps disconnect and reconnect to a new image without relaunching", async () => {
    for (const app of [APP, SECOND_APP]) {
      simctl(["launch", udid!, app]);
      await waitFor(() => lines(app, "camera").some((line) => line.endsWith("no device")));
    }
    const starts = [APP, SECOND_APP].map((app) => lines(app, "start"));
    const permissions = [APP, SECOND_APP].map((app) => lines(app, "permission")[0]!.split("\t")[2]);
    const springboard = springboardPid();
    for (const [source, expected] of [[red, "255,0,0"], [blue, "0,0,255"], [red, "255,0,0"]]) {
      const before = [APP, SECOND_APP].map((app) => lines(app, "frame").length);
      cli(["enable", "--file", source!]);
      for (const [i, app] of [APP, SECOND_APP].entries()) {
        simctl(["launch", udid!, app]);
        await waitFor(() => lines(app, "frame").length > before[i]! && lines(app, "frame").at(-1)!.endsWith(expected!));
        expect(lines(app, "frame").at(-1)).toEndWith(expected!);
        expect(lines(app, "start")).toEqual(starts[i]!);
      }
      const disconnected = [APP, SECOND_APP].map((app) => lines(app, "disconnected").length);
      cli(["disable"]);
      for (const [i, app] of [APP, SECOND_APP].entries()) {
        simctl(["launch", udid!, app]);
        await waitFor(() => lines(app, "disconnected").length > disconnected[i]!);
        expect(lines(app, "disconnected").at(-1)).toEndWith(`connected=0 legacy=0 devices=0 permission=${permissions[i]}`);
        expect(lines(app, "start")).toEqual(starts[i]!);
        const samples = lines(app, "sample").length;
        await Bun.sleep(400);
        expect(lines(app, "sample").length).toBe(samples);
      }
      expect(springboardPid()).toBe(springboard);
      expect(readInsert(udid!)).toContain("libServeSimTrampoline.dylib");
    }
  }, 180_000);
  test("queued cached frames do not arrive after disconnect", async () => {
    try { simctl(["terminate", udid!, APP]); } catch {}
    cli(["enable", "--file", red]);
    const suspended = lines(APP, "queue-suspended").length;
    const drained = lines(APP, "queue-drained").length;
    const samples = lines(APP, "queued-sample").length;
    simctl(["launch", udid!, APP, "-ServeSimFixtureQueuedFrames"]);
    await waitFor(() => lines(APP, "queue-suspended").length > suspended);
    cli(["disable"]);
    await waitFor(() => lines(APP, "queue-drained").length > drained);
    expect(lines(APP, "queued-sample").length).toBe(samples);
  }, 60_000);

});
