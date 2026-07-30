// Preparing one simulator app to be captured: trust the proxy's certificate, then relaunch the app with
// the proxy applied to its own process.

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { dirnameOf } from "./runtime";

const execFileAsync = promisify(execFile);
const __dirname = dirnameOf(import.meta.url);
const DYLIB_NAME = "libSimNetProxy.dylib";
const SIMCTL_TIMEOUT_MS = 30_000;

const simctl = (args: string[], env?: NodeJS.ProcessEnv) =>
  execFileAsync("xcrun", ["simctl", ...args], { timeout: SIMCTL_TIMEOUT_MS, env });

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
  return candidates.find(existsSync) ?? null;
}

export interface AttachDeps {
  dylib?: () => string | null;
  run?: (args: string[], env?: NodeJS.ProcessEnv) => Promise<unknown>;
}

/**
 * Relaunch an app with its traffic pointed at the proxy.
 *
 * The relaunch is unavoidable: `DYLD_INSERT_LIBRARIES` only applies at process start. Stopping capture
 * does not relaunch again — that would cost the developer their app's state to unset a setting that dies
 * with the process anyway.
 */
export async function attachApp(
  udid: string,
  bundleId: string,
  proxyPort: number,
  deps: AttachDeps = {},
): Promise<void> {
  const run = deps.run ?? ((args: string[], env?: NodeJS.ProcessEnv) => simctl(args, env));
  const library = (deps.dylib ?? locateProxyDylib)();
  if (!library) {
    throw new Error(
      `Could not find ${DYLIB_NAME}, the library that points an app at the capture proxy. This build of ` +
        "serve-sim is missing dist/simnet; reinstall from a recent release.",
    );
  }

  await run(["terminate", udid, bundleId]).catch(() => {});

  // Appended, not assigned: the camera injector uses the same variable and would otherwise be silently
  // disabled for this launch. simctl strips the SIMCTL_CHILD_ prefix when passing these to the app.
  const existing = process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES;
  const inserts = existing && !existing.includes(library) ? `${existing}:${library}` : library;
  await run(["launch", udid, bundleId], {
    ...process.env,
    SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: inserts,
    SIMCTL_CHILD_SIMNET_PROXY_PORT: String(proxyPort),
  });
}
