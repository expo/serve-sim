// Preparing one simulator for capture: trust the proxy's certificate, then point every app it launches at
// the proxy.
//
// The injection is set once, in the simulator's own launchd, rather than per app launch. That is what lets
// capture see an app's very first request: `DYLD_INSERT_LIBRARIES` only applies at process start, so
// anything applied per-launch has to relaunch the app — destroying the startup traffic it was meant to
// record.

import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { dirnameOf } from "./runtime";

const execFileAsync = promisify(execFile);
const __dirname = dirnameOf(import.meta.url);
const DYLIB_NAME = "libSimNetProxy.dylib";
const SIMCTL_TIMEOUT_MS = 30_000;
const INJECTED_VARS = ["DYLD_INSERT_LIBRARIES", "SIMNET_PROXY_PORT_FILE"] as const;

const simctl = (args: string[]) =>
  execFileAsync("xcrun", ["simctl", ...args], { timeout: SIMCTL_TIMEOUT_MS });

/**
 * Trust the proxy's root in one simulator.
 *
 * There is deliberately no counterpart: simctl can only `reset` the whole keychain, which would take the
 * app's own stored credentials with it. The certificate is instead made harmless — its private key lives
 * in the proxy's per-session directory and is deleted with it.
 */
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

function locateProxyDylib(): string | null {
  const candidates = [
    join(__dirname, "..", "dist", "simnet", DYLIB_NAME),
    join(__dirname, "simnet", DYLIB_NAME),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export interface InjectionDeps {
  dylib?: () => string | null;
  run?: (args: string[]) => Promise<unknown>;
}

/**
 * Point every app the simulator launches from now on at the proxy.
 *
 * Set in the simulator's launchd, so it covers apps the developer opens by hand as well as ones serve-sim
 * launches, and it survives for the device's boot session. Apps already running keep the environment they
 * started with; reaching those needs a relaunch, which is the device reboot the UI offers.
 *
 * The port is handed over as a file path so this cannot go stale: the file dies with the proxy, so a
 * variable left behind by a crash makes apps come up unproxied rather than pointed somewhere unrelated.
 */
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
 * What the simulator's launchd will insert into apps it launches, if anything.
 *
 * A launch that sets `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` replaces this value rather than adding to it, so
 * any caller doing that has to merge this in or it silently drops capture for the app it launches.
 * Synchronous because the camera launch path is.
 */
export function bootInjectedLibraries(udid: string): string | null {
  const result = spawnSync(
    "xcrun",
    ["simctl", "spawn", udid, "launchctl", "getenv", "DYLD_INSERT_LIBRARIES"],
    { encoding: "utf8", timeout: SIMCTL_TIMEOUT_MS },
  );
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  // The injected library logs to stderr from every process it loads into, including this `launchctl`.
  const value = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("[simnetproxy]"))
    .at(-1);
  return value && value.includes(DYLIB_NAME) ? value : null;
}

/**
 * Whether the device is still pointed at this proxy.
 *
 * Capture is applied to a boot session, so anything that ends that session — Simulator's own restart, a
 * crash, `simctl shutdown` — silently drops the injection while this process still believes it is
 * capturing. Asking the device is the only way to know; remembering what we set is what produces a panel
 * that claims to be recording an app it cannot see.
 */
export async function deviceIsInjected(
  udid: string,
  portFile: string,
  deps: InjectionDeps & { read?: (args: string[]) => Promise<string> } = {},
): Promise<boolean> {
  const read =
    deps.read ??
    (async (args: string[]) => {
      const { stdout } = await execFileAsync("xcrun", ["simctl", ...args], {
        timeout: SIMCTL_TIMEOUT_MS,
        encoding: "utf8",
      });
      return stdout;
    });
  try {
    const value = await read(["spawn", udid, "launchctl", "getenv", "SIMNET_PROXY_PORT_FILE"]);
    // The injected library logs from every process it loads into, this `launchctl` included.
    return value
      .split("\n")
      .some((line) => line.trim() === portFile);
  } catch {
    // A device that cannot be reached is not capturing.
    return false;
  }
}

/**
 * Stop pointing newly launched apps at the proxy.
 *
 * Best-effort by design. The proxy stops answering when the session ends, and the injected library checks
 * that the port is live before touching an app's networking — so a variable left behind by a crash costs a
 * launch-time loopback probe, not a broken app.
 */
export async function clearBootInjection(udid: string, deps: InjectionDeps = {}): Promise<void> {
  const run = deps.run ?? ((args: string[]) => simctl(args));
  for (const name of INJECTED_VARS) {
    await run(["spawn", udid, "launchctl", "unsetenv", name]).catch(() => {});
  }
}

