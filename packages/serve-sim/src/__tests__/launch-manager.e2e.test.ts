import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { findBootedDevice } from "../device";
import { clearLaunchState, disableCapability, enableCapability, launchApp } from "../launch-manager";

// The trampoline defers its dlopen, so every assertion polls.

const PROBE = join(import.meta.dir, "../../dist/trampoline/libServeSimProbe.dylib");
const MARKER = join(tmpdir(), `serve-sim-probe-e2e-${process.pid}.txt`);
const APP = "host.exp.Exponent";
const OTHER_APP = "com.apple.mobilesafari";

// Pin the device with SERVE_SIM_TEST_UDID; first-booted-wins races other sessions.
const udid = process.env.SERVE_SIM_TEST_UDID ?? findBootedDevice();
const ready = udid !== null && existsSync(PROBE) && isInstalled(udid, APP);

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

function isInstalled(device: string, bundleId: string): boolean {
  try {
    simctl(["get_app_container", device, bundleId, "app"]);
    return true;
  } catch {
    return false;
  }
}

function markerLines(): string[] {
  try {
    return readFileSync(MARKER, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function waitForNewLine(before: number, timeoutMs = 20_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = markerLines();
    if (lines.length > before) return lines;
    await new Promise((r) => setTimeout(r, 250));
  }
  return markerLines();
}

beforeAll(() => {
  if (!udid) return;
  try { simctl(["spawn", udid, "launchctl", "unsetenv", "DYLD_INSERT_LIBRARIES"]); } catch {}
  clearLaunchState(udid);
  try { rmSync(join(import.meta.dir, "../../dist/trampoline/capabilities.conf")); } catch {}
  try { rmSync(MARKER); } catch {}
});

afterAll(() => {
  if (!udid) return;
  try { simctl(["spawn", udid, "launchctl", "unsetenv", "DYLD_INSERT_LIBRARIES"]); } catch {}
  terminate(udid, APP);
  terminate(udid, OTHER_APP);
  clearLaunchState(udid);
  try { rmSync(MARKER); } catch {}
});

describe.skipIf(!ready)("launch manager capabilities", () => {
  test("loads a capability into an app the manager launches", async () => {
    terminate(udid!, APP);
    await enableCapability(udid!, APP, {
      name: "probe",
      dylib: PROBE,
      env: { SERVE_SIM_PROBE_FILE: MARKER },
    });
    const lines = await waitForNewLine(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.at(-1)).toContain(".app/");
  });

  test("loads into a launch the manager did not perform", async () => {
    const before = markerLines().length;
    terminate(udid!, APP);
    simctl(["openurl", udid!, "exp://127.0.0.1:8081"]);
    expect((await waitForNewLine(before)).length).toBeGreaterThan(before);
  });

  test("keeps the recorded launch arguments across a capability relaunch", async () => {
    await launchApp(udid!, { bundleId: APP, launchArgs: ["-ServeSimProbeMarker", "1"] });
    const before = markerLines().length;
    await enableCapability(udid!, APP, {
      name: "probe",
      dylib: PROBE,
      env: { SERVE_SIM_PROBE_FILE: MARKER },
    });
    const pid = (await waitForNewLine(before)).at(-1)?.split("\t")[0];
    const info = simctl(["spawn", udid!, "launchctl", "procinfo", pid!]);
    expect(info).toContain("-ServeSimProbeMarker");
  });

  test("refuses an app with no data container instead of loading nowhere", async () => {
    await expect(
      enableCapability(udid!, "com.apple.Preferences", {
        name: "probe",
        dylib: PROBE,
        env: { SERVE_SIM_PROBE_FILE: MARKER },
      }),
    ).rejects.toThrow("no data container");
  });

  test("leaves an app outside the capability set alone", async () => {
    terminate(udid!, OTHER_APP);
    simctl(["launch", udid!, OTHER_APP]);
    await new Promise((r) => setTimeout(r, 3_000));
    const other = simctl(["spawn", udid!, "launchctl", "list"])
      .split("\n")
      .find((line) => line.includes(OTHER_APP));
    const pid = other?.split("\t")[0];
    expect(markerLines().some((line) => line.startsWith(`${pid}\t`))).toBe(false);
  });

  test("disabling a capability stops it loading", async () => {
    await disableCapability(udid!, APP, "probe");
    const before = markerLines().length;
    terminate(udid!, APP);
    simctl(["launch", udid!, APP]);
    await new Promise((r) => setTimeout(r, 3_000));
    expect(markerLines().length).toBe(before);
  });
});
