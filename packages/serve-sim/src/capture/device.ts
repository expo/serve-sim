import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { dirnameOf } from "../runtime";

const execFileAsync = promisify(execFile);
const __dirname = dirnameOf(import.meta.url);
const DYLIB_NAME = "libSimNetProxy.dylib";
const SIMCTL_TIMEOUT_MS = 30_000;
const INJECTED_VARS = ["DYLD_INSERT_LIBRARIES", "SIMNET_PROXY_PORT_FILE"] as const;

const simctl = (args: string[]) =>
  execFileAsync("xcrun", ["simctl", ...args], { timeout: SIMCTL_TIMEOUT_MS });

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

export interface InjectionDeps {
  dylib?: () => string | null;
  run?: (args: string[]) => Promise<unknown>;
}

/** Port is a file path so a crash cannot leave apps aimed at a stale port number. */
export async function injectAtBoot(
  udid: string,
  portFile: string,
  deps: InjectionDeps = {},
): Promise<void> {
  const run = deps.run ?? ((args: string[]) => simctl(args));
  const library = (deps.dylib ?? locateProxyDylib)();
  if (!library) {
    throw new Error(
      `Could not find ${DYLIB_NAME}, the library that points an app at the capture proxy. This build of ` +
        "serve-sim is missing dist/simnet; reinstall from a recent release.",
    );
  }

  await run(["spawn", udid, "launchctl", "setenv", "DYLD_INSERT_LIBRARIES", library]);
  await run(["spawn", udid, "launchctl", "setenv", "SIMNET_PROXY_PORT_FILE", portFile]);
}

/**
 * `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` replaces launchd's value — callers must merge or they drop capture.
 */
export function bootInjectedLibraries(udid: string): string | null {
  const result = spawnSync(
    "xcrun",
    ["simctl", "spawn", udid, "launchctl", "getenv", "DYLD_INSERT_LIBRARIES"],
    { encoding: "utf8", timeout: SIMCTL_TIMEOUT_MS },
  );
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const value = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("[simnetproxy]"))
    .at(-1);
  return value && value.includes(DYLIB_NAME) ? value : null;
}

type ReadEnv = (args: string[]) => Promise<string>;

const readSimctl: ReadEnv = async (args) => {
  const { stdout } = await execFileAsync("xcrun", ["simctl", ...args], {
    timeout: SIMCTL_TIMEOUT_MS,
    encoding: "utf8",
  });
  return stdout;
};

/** Values launchd reports for a variable, minus the dylib's own log lines, which land on the same stream. */
async function readInjectedVar(udid: string, name: string, read: ReadEnv): Promise<string[]> {
  const value = await read(["spawn", udid, "launchctl", "getenv", name]);
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("[simnetproxy]"));
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
  const run = deps.run ?? ((args: string[]) => simctl(args));
  for (const name of INJECTED_VARS) {
    try {
      await run(["spawn", udid, "launchctl", "unsetenv", name]);
    } catch (error) {
      // The device is gone, so the remaining variables went with it.
      if (isDeviceUnavailable(error)) return;
      throw new Error(
        `Could not clear ${name} on ${udid}, so apps launched on it may still load the capture library. ` +
          `Reboot the device to clear it. (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
}

/** Whether the device still carries either injected variable. Used to verify a teardown actually took. */
export async function bootInjectionCleared(
  udid: string,
  deps: { read?: ReadEnv } = {},
): Promise<boolean> {
  const read = deps.read ?? readSimctl;
  for (const name of INJECTED_VARS) {
    try {
      if ((await readInjectedVar(udid, name, read)).length > 0) return false;
    } catch (error) {
      if (isDeviceUnavailable(error)) continue;
      return false;
    }
  }
  return true;
}
