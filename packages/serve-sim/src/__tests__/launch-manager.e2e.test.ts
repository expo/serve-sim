import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { findBootedDevice } from "../device";
import { launchAppAsync } from "../launch-app";
import { clearLaunchState, disableCapability, enableCapability, launchApp } from "../launch-manager";

// The trampoline defers its dlopen, so every assertion polls.

const DIST = join(import.meta.dir, "../../dist/trampoline");
const PROBE = join(DIST, "libServeSimProbe.dylib");
const FIXTURE = join(DIST, "ServeSimLaunchFixture.app");
const MARKER = join(tmpdir(), `serve-sim-probe-e2e-${process.pid}.txt`);
const APP = "dev.expo.serve-sim.launch-fixture";
const OTHER_APP = "com.apple.mobilesafari";

// Pin the device with SERVE_SIM_TEST_UDID; first-booted-wins races other sessions.
const udid = process.env.SERVE_SIM_TEST_UDID ?? findBootedDevice();
const ready = udid !== null && existsSync(PROBE) && existsSync(FIXTURE);

function simctl(args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

// `simctl terminate` exits non-zero when the app is not running.
function terminate(device: string, bundleId: string): void {
  try { simctl(["terminate", device, bundleId]); } catch {}
}

function markerLines(): string[] {
  try {
    return readFileSync(MARKER, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// What the fixture itself saw, as "<kind>\t<pid>\t<detail>" lines. Reading it
// back from the app's own container is the only way to tell a launch that
// carried the arguments from one that merely started.
function fixtureLines(): string[] {
  try {
    const container = simctl(["get_app_container", udid!, APP, "data"]).trim();
    return readFileSync(join(container, "Documents/launches.tsv"), "utf-8")
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function waitForMatch(
  read: () => string[],
  match: (line: string) => boolean,
  timeoutMs = 20_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = read();
    if (lines.some(match)) return lines;
    await new Promise((r) => setTimeout(r, 250));
  }
  return read();
}

async function waitForLines(
  read: () => string[],
  before: number,
  timeoutMs = 20_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = read();
    if (lines.length > before) return lines;
    await new Promise((r) => setTimeout(r, 250));
  }
  return read();
}

beforeAll(() => {
  if (!ready) return;
  try { simctl(["spawn", udid!, "launchctl", "unsetenv", "DYLD_INSERT_LIBRARIES"]); } catch {}
  clearLaunchState(udid!);
  try { rmSync(join(DIST, "capabilities.conf")); } catch {}
  try { rmSync(MARKER); } catch {}
  // Reinstall so the recorded launches start from an empty container.
  try { simctl(["uninstall", udid!, APP]); } catch {}
  simctl(["install", udid!, FIXTURE]);
}, 60_000);

afterAll(() => {
  if (!ready) return;
  try { simctl(["spawn", udid!, "launchctl", "unsetenv", "DYLD_INSERT_LIBRARIES"]); } catch {}
  terminate(udid!, APP);
  terminate(udid!, OTHER_APP);
  clearLaunchState(udid!);
  try { rmSync(MARKER); } catch {}
  try { simctl(["uninstall", udid!, APP]); } catch {}
}, 60_000);

describe.skipIf(!ready)("launch manager launches", () => {
  test("passes the launch arguments to the application", async () => {
    const before = fixtureLines().length;
    await launchAppAsync(udid!, { bundleId: APP, launchArgs: ["-ServeSimFixtureFlag", "1"] });
    const line = (await waitForLines(fixtureLines, before)).at(-1);
    expect(line).toStartWith("launch\t");
    expect(line?.split("\t")[2]).toBe("-ServeSimFixtureFlag\x1f1");
  }, 30_000);

  test("opens a URL in the application it launched", async () => {
    const opened = (line: string): boolean =>
      line.startsWith("openurl\t") && line.endsWith("serve-sim-fixture://opened");
    await launchAppAsync(udid!, {
      bundleId: APP,
      launchArgs: [],
      openUrl: "serve-sim-fixture://opened",
    });
    expect((await waitForMatch(fixtureLines, opened)).some(opened)).toBe(true);
  }, 30_000);
});

describe.skipIf(!ready)("launch manager capabilities", () => {
  test("loads a capability into an app the manager launches", async () => {
    terminate(udid!, APP);
    await enableCapability(udid!, APP, {
      name: "probe",
      dylib: PROBE,
      env: { SERVE_SIM_PROBE_FILE: MARKER },
    });
    const lines = await waitForLines(markerLines, 0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.at(-1)).toContain(".app/");
  }, 30_000);

  test("loads into a launch the manager did not perform", async () => {
    const before = markerLines().length;
    terminate(udid!, APP);
    simctl(["openurl", udid!, "serve-sim-fixture://cold"]);
    expect((await waitForLines(markerLines, before)).length).toBeGreaterThan(before);
  }, 30_000);

  test("keeps the recorded launch arguments across a capability relaunch", async () => {
    await launchApp(udid!, { bundleId: APP, launchArgs: ["-ServeSimProbeMarker", "1"] });
    const before = fixtureLines().length;
    await enableCapability(udid!, APP, {
      name: "probe",
      dylib: PROBE,
      env: { SERVE_SIM_PROBE_FILE: MARKER },
    });
    const relaunch = (await waitForLines(fixtureLines, before))
      .slice(before)
      .find((line) => line.startsWith("launch\t"));
    expect(relaunch?.split("\t")[2]).toBe("-ServeSimProbeMarker\x1f1");
  }, 30_000);

  test("refuses an app with no data container instead of loading nowhere", async () => {
    await expect(
      enableCapability(udid!, "com.apple.Preferences", {
        name: "probe",
        dylib: PROBE,
        env: { SERVE_SIM_PROBE_FILE: MARKER },
      }),
    ).rejects.toThrow("no data container");
  }, 30_000);

  test("leaves an app outside the capability set alone", async () => {
    terminate(udid!, OTHER_APP);
    simctl(["launch", udid!, OTHER_APP]);
    await new Promise((r) => setTimeout(r, 3_000));
    const other = simctl(["spawn", udid!, "launchctl", "list"])
      .split("\n")
      .find((line) => line.includes(OTHER_APP));
    const pid = other?.split("\t")[0];
    expect(markerLines().some((line) => line.startsWith(`${pid}\t`))).toBe(false);
  }, 30_000);

  test("disabling a capability stops it loading", async () => {
    await disableCapability(udid!, APP, "probe");
    const before = markerLines().length;
    terminate(udid!, APP);
    simctl(["launch", udid!, APP]);
    await new Promise((r) => setTimeout(r, 3_000));
    expect(markerLines().length).toBe(before);
  }, 30_000);
});
