// Turning capture on or off for a device that is already up.
//
// Capture is applied when a device boots, so changing it costs a reboot. That is the whole cost model the
// UI presents: a device is either booted for capture or it is not, and switching means restarting it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { captureRuntime, type CaptureRuntime } from "./capture-runtime";
import { type CaptureMeta } from "./capture-store";

const execFileAsync = promisify(execFile);
const SHUTDOWN_TIMEOUT_MS = 60_000;
const BOOT_TIMEOUT_MS = 120_000;

export interface RebootDeps {
  runtime?: CaptureRuntime;
  shutdown?: (udid: string) => Promise<void>;
  boot?: (udid: string) => Promise<void>;
}

async function simctlShutdown(udid: string): Promise<void> {
  await execFileAsync("xcrun", ["simctl", "shutdown", udid], { timeout: SHUTDOWN_TIMEOUT_MS }).catch(
    (error: unknown) => {
      // Already down is the state we wanted.
      const text = error instanceof Error ? error.message : String(error);
      if (!/current state|shutdown/i.test(text)) throw error;
    },
  );
}

async function simctlBoot(udid: string): Promise<void> {
  await execFileAsync("xcrun", ["simctl", "boot", udid], { timeout: BOOT_TIMEOUT_MS });
  // Blocks until the device's services are actually up, not just flipped to "Booted" — without it the
  // injection below can land before launchd is listening for it.
  await execFileAsync("xcrun", ["simctl", "bootstatus", udid, "-b"], {
    timeout: BOOT_TIMEOUT_MS,
  }).catch(() => {});
}

/**
 * Reboot a device with capture either on or off, and report the state it came back in.
 *
 * The old session is torn down first: its proxy and its injection belong to the boot that is ending, and
 * leaving the injection set would point the new boot's apps at a port nobody is serving.
 */
const inFlight = new Map<string, Promise<CaptureMeta>>();

export async function rebootWithCapture(
  udid: string,
  enabled: boolean,
  deps: RebootDeps = {},
): Promise<CaptureMeta> {
  // Two reboots at once would interleave a shutdown with a boot and leave the device in neither state. A
  // second caller joins the reboot already running rather than starting a competing one.
  const running = inFlight.get(udid);
  if (running) return running;

  const runtime = deps.runtime ?? captureRuntime;
  const shutdown = deps.shutdown ?? simctlShutdown;
  const boot = deps.boot ?? simctlBoot;

  const attempt = (async () => {
    await runtime.disableForDevice(udid);
    await shutdown(udid);
    await boot(udid);
    if (!enabled) return runtime.metaFor(udid);
    return runtime.enableForDevice(udid);
  })();
  inFlight.set(udid, attempt);
  try {
    return await attempt;
  } finally {
    inFlight.delete(udid);
  }
}
