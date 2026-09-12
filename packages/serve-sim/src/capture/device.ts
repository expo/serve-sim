import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { withLaunchStateLock } from "../launch-state-lock";
import { dirnameOf } from "../runtime";
import { simctl } from "../simctl";

const __dirname = dirnameOf(import.meta.url);
const DYLIB_NAME = "libSimNetProxy.dylib";
const INJECTED_VARS = ["DYLD_INSERT_LIBRARIES", "SIMNET_PROXY_PORT_FILE"] as const;

/** Trust the proxy root. No untrust — simctl can only reset the whole keychain. */
export async function trustCaInSimulator(udid: string, caPem: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-ca-"));
  const certPath = join(dir, "capture-root.crt");
  try {
    writeFileSync(certPath, caPem);
    await simctl(["keychain", udid, "add-root-cert", certPath]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Bundled next to the CLI, or under `dist/` when running from a checkout. */
export function proxyDylibCandidates(): string[] {
  return [
    join(__dirname, "simnet", DYLIB_NAME),
    join(__dirname, "..", "dist", "simnet", DYLIB_NAME),
    join(__dirname, "..", "..", "dist", "simnet", DYLIB_NAME),
  ];
}

function locateProxyDylib(): string | null {
  return proxyDylibCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

// DYLD_INSERT_LIBRARIES is a colon-separated list, and the capability loader arms itself the same way.
// Touch only our own entry, or enabling capture drops every other tool's library.
function injectedLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("[simnetproxy]"));
}

function withoutProxyEntry(current: string): string[] {
  return injectedLines(current)
    .flatMap((line) => line.split(":"))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && basename(entry) !== DYLIB_NAME);
}

export interface InjectionDeps {
  dylib?: () => string | null;
  run?: (args: string[]) => Promise<string>;
}

/** Port is a file path so a crash cannot leave apps aimed at a stale port number. */
export async function injectAtBoot(
  udid: string,
  portFile: string,
  deps: InjectionDeps = {},
): Promise<void> {
  const run = deps.run ?? simctl;
  const library = (deps.dylib ?? locateProxyDylib)();
  if (!library) {
    throw new Error(
      `Could not find ${DYLIB_NAME}, the library that points an app at the capture proxy. This build of ` +
        "serve-sim is missing dist/simnet; reinstall from a recent release.",
    );
  }

  // The capability loader arms the insert list under this same lock, and the two variables only mean
  // anything together: a device carrying one without the other launches apps unproxied.
  await withLaunchStateLock(udid, async () => {
    const current = await run(["spawn", udid, "launchctl", "getenv", "DYLD_INSERT_LIBRARIES"]);
    const next = [...withoutProxyEntry(current), library].join(":");
    await run(["spawn", udid, "launchctl", "setenv", "DYLD_INSERT_LIBRARIES", next]);
    await run(["spawn", udid, "launchctl", "setenv", "SIMNET_PROXY_PORT_FILE", portFile]);
  });
}

type ReadEnv = (args: string[]) => Promise<string>;

/** Values launchd reports for a variable, minus the dylib's own log lines, which land on the same stream. */
async function readInjectedVar(udid: string, name: string, read: ReadEnv): Promise<string[]> {
  return injectedLines(await read(["spawn", udid, "launchctl", "getenv", name]));
}

/** A device that is gone cannot still be injected, so its failure is the one safe failure to ignore. */
function isDeviceUnavailable(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /Unable to lookup device|Invalid device|current state: Shutdown|device is not booted/i.test(
    text,
  );
}

/**
 * Stop pointing newly launched apps at the proxy.
 *
 * Only an unavailable device is ignored. Any other failure leaves the variables set, so apps the developer
 * launches later keep loading the capture dylib — reporting that as a clean teardown is how a device stays
 * injected without anyone knowing.
 */
export async function clearBootInjection(udid: string, deps: InjectionDeps = {}): Promise<void> {
  const run = deps.run ?? simctl;
  let clearing: (typeof INJECTED_VARS)[number] = "DYLD_INSERT_LIBRARIES";
  try {
    // Held across both writes: a loader arming between the read and the clear would be erased, and a
    // device that keeps one variable without the other reports itself injected while nothing is proxied.
    await withLaunchStateLock(udid, async () => {
      const remaining = withoutProxyEntry(
        await run(["spawn", udid, "launchctl", "getenv", "DYLD_INSERT_LIBRARIES"]),
      );
      if (remaining.length === 0) {
        await run(["spawn", udid, "launchctl", "unsetenv", "DYLD_INSERT_LIBRARIES"]);
      } else {
        await run(["spawn", udid, "launchctl", "setenv", "DYLD_INSERT_LIBRARIES", remaining.join(":")]);
      }
      clearing = "SIMNET_PROXY_PORT_FILE";
      await run(["spawn", udid, "launchctl", "unsetenv", "SIMNET_PROXY_PORT_FILE"]);
    });
  } catch (error) {
    // The device is gone, so the remaining variables went with it.
    if (isDeviceUnavailable(error)) return;
    throw new Error(
      `Could not clear ${clearing} on ${udid}, so apps launched on it may still load the capture library. ` +
        `Reboot the device to clear it. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export async function bootInjectionCleared(
  udid: string,
  deps: { read?: ReadEnv } = {},
): Promise<boolean> {
  const read = deps.read ?? simctl;
  for (const name of INJECTED_VARS) {
    try {
      const values = await readInjectedVar(udid, name, read);
      if (name === "DYLD_INSERT_LIBRARIES") {
        // The capability loader arms the same variable, so only our own entry means capture is still on.
        const entries = values.flatMap((line) => line.split(":"));
        if (entries.some((entry) => basename(entry.trim()) === DYLIB_NAME)) return false;
        continue;
      }
      if (values.length > 0) return false;
    } catch (error) {
      if (isDeviceUnavailable(error)) continue;
      return false;
    }
  }
  return true;
}
