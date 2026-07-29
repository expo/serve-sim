// Pointing one app at the capture proxy, without touching the host.
//
// An iOS simulator has no network configuration of its own; it reads the host's. Earlier versions of
// this therefore set the *machine's* system proxy, which routed every process on the developer's Mac
// through the capture proxy and left their network broken whenever the proxy went away. Nothing about
// that was fixable: a machine-wide setting always needs restoring, and restoring can always fail.
//
// So the proxy is applied inside the app instead. `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` loads a small
// library into the app at launch, and that library sets `connectionProxyDictionary` on the app's own URL
// sessions. Only that process is affected, so there is no host state, nothing to restore, and nothing to
// leak if the session dies.
//
// The cost is a relaunch: DYLD injection only applies at process start, so capture cannot attach to an
// app that is already running. The same constraint applies to the camera injector this mirrors.
//
// There is deliberately no detach. Stopping capture leaves the app as it is rather than restarting it a
// second time: a relaunch the developer did not ask for costs them their app's state, and the setting it
// would remove is scoped to that one process anyway. The app keeps sending requests to a port that has
// stopped listening until it is next launched, at which point it comes up clean.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { dirnameOf } from "./runtime";

const execFileAsync = promisify(execFile);

// Bun's bundler inlines a bare `__dirname` as the build machine's source directory.
const __dirname = dirnameOf(import.meta.url);

const DYLIB_NAME = "libSimNetProxy.dylib";

/**
 * Path to the injected proxy library.
 *
 * The candidates match `locateCameraDylib`: the dev layout builds into `dist/simnet/`, and the published
 * tarball ships the same file at `<package>/dist/simnet/`.
 */
function locateProxyDylib(): string | null {
  const candidates = [
    join(__dirname, "..", "dist", "simnet", DYLIB_NAME),
    join(__dirname, "simnet", DYLIB_NAME),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface InjectionDeps {
  dylib?: () => string | null;
  terminate?: (udid: string, bundleId: string) => Promise<void>;
  launch?: (udid: string, bundleId: string, env: NodeJS.ProcessEnv) => Promise<void>;
}

/** Relaunching one app with the capture proxy applied to it. */
export type CaptureInjection = ReturnType<typeof createCaptureInjection>;

export function createCaptureInjection(deps: InjectionDeps = {}) {
  const dylib = deps.dylib ?? locateProxyDylib;
  const terminate =
    deps.terminate ??
    (async (udid: string, bundleId: string) => {
      // A not-running app is the desired state, so a failure here is not one.
      await execFileAsync("xcrun", ["simctl", "terminate", udid, bundleId], {
        timeout: 20_000,
      }).catch(() => {});
    });
  const launch =
    deps.launch ??
    (async (udid: string, bundleId: string, env: NodeJS.ProcessEnv) => {
      await execFileAsync("xcrun", ["simctl", "launch", udid, bundleId], { timeout: 30_000, env });
    });

  return {
    /**
     * Relaunch an app with its traffic pointed at the proxy.
     *
     * Throws with a reason the UI can show: capture that silently records nothing is worse than capture
     * that says why it could not start.
     */
    async attach(udid: string, bundleId: string, proxyPort: number): Promise<void> {
      const library = dylib();
      if (!library) {
        throw new Error(
          `Could not find ${DYLIB_NAME}, the library that points an app at the capture proxy. This ` +
            "build of serve-sim is missing dist/simnet; reinstall from a recent release.",
        );
      }
      await terminate(udid, bundleId);
      // Appended rather than assigned: the camera injector uses the same variable, and overwriting it
      // would silently turn that feature off for this launch (and vice versa). DYLD takes a
      // colon-separated list.
      const existing = process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES;
      const inserts = existing && !existing.includes(library) ? `${existing}:${library}` : library;
      await launch(udid, bundleId, {
        ...process.env,
        // simctl strips the SIMCTL_CHILD_ prefix when it passes these to the app.
        SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: inserts,
        SIMCTL_CHILD_SIMNET_PROXY_PORT: String(proxyPort),
      });
    },

  };
}

export const captureInjection = createCaptureInjection();
