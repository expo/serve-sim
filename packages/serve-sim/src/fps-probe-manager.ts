import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  buildCameraDylib,
  cameraShmName,
  fpsDylib,
  injectedAppEnvironment,
  locateCameraDylib,
} from "./app-injection";
import { readInjectedCameraBundles } from "./camera-helper";
import {
  foregroundTracker,
  type ForegroundApp,
  type ForegroundTrackerCache,
} from "./foreground-tracker";
import {
  fpsShmName,
  readFpsSample,
  unlinkFpsShm,
  type FpsSample,
} from "./fps-shm";

const execFileAsync = promisify(execFile);
const DEFAULT_GRACE_MS = 1250;
const DEFAULT_VERIFY_MS = 1250;
const DEFAULT_RETRY_MS = 30_000;
const MAX_FAILURES = 3;

type RunSimctl = (
  args: string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

export interface FpsProbeManagerDeps {
  tracker?: ForegroundTrackerCache;
  readFps?: (udid: string, bundleId: string) => FpsSample | null;
  isInstalledApp?: (udid: string, bundleId: string) => Promise<boolean>;
  launch?: (
    udid: string,
    bundleId: string,
    env: NodeJS.ProcessEnv,
    stopped: () => boolean,
  ) => Promise<number | null>;
  launchEnvironment?: (udid: string, bundleId: string) => NodeJS.ProcessEnv;
  resetShm?: (udid: string) => void;
  graceMs?: number;
  verifyMs?: number;
  retryMs?: number;
}

export interface FpsProbeManager {
  stop: () => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isInstalledApp(udid: string, bundleId: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "xcrun",
      ["simctl", "get_app_container", udid, bundleId, "app"],
      { timeout: 3000 },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function launchWithProbe(
  udid: string,
  bundleId: string,
  env: NodeJS.ProcessEnv,
  stopped: () => boolean,
  runSimctl: RunSimctl = (args, options) => execFileAsync("xcrun", args, options),
): Promise<number | null> {
  await runSimctl(["simctl", "terminate", udid, bundleId], {
    timeout: 3000,
  }).catch(() => {});
  if (stopped()) return null;
  const { stdout } = await runSimctl(["simctl", "launch", udid, bundleId], {
    timeout: 5000,
    env,
  });
  const match = stdout.trim().match(/:\s*(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

function launchEnvironment(udid: string, bundleId: string): NodeJS.ProcessEnv {
  const preserveCamera = readInjectedCameraBundles(udid).includes(bundleId);
  const cameraDylib = preserveCamera ? (locateCameraDylib() ?? buildCameraDylib()) : null;
  return injectedAppEnvironment({
    fps: { dylib: fpsDylib(), shmName: fpsShmName(udid) },
    ...(cameraDylib
      ? { camera: { dylib: cameraDylib, shmName: cameraShmName(udid) } }
      : {}),
  });
}

export function launchAppWithFpsProbe(
  udid: string,
  bundleId: string,
): Promise<number | null> {
  const environment = launchEnvironment(udid, bundleId);
  unlinkFpsShm(udid);
  return launchWithProbe(udid, bundleId, environment, () => false);
}

function isFreshForProcess(sample: FpsSample | null, observedAt: number): boolean {
  return sample !== null && sample.timestampMs >= observedAt;
}

export function startFpsProbeManager(
  udid: string,
  deps: FpsProbeManagerDeps = {},
): FpsProbeManager {
  const tracker = deps.tracker ?? foregroundTracker;
  const readFps = deps.readFps ?? readFpsSample;
  const checkInstalled = deps.isInstalledApp ?? isInstalledApp;
  const launch = deps.launch ?? launchWithProbe;
  const environment = deps.launchEnvironment ?? launchEnvironment;
  const resetShm = deps.resetShm ?? unlinkFpsShm;
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  const verifyMs = deps.verifyMs ?? DEFAULT_VERIFY_MS;
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { app: ForegroundApp; observedAt: number; dueAt: number } | null = null;
  let running = false;
  const failures = new Map<string, { pid: number; count: number; retryAt: number }>();

  const currentMatches = (app: ForegroundApp): boolean => {
    const current = tracker.peek(udid);
    return current?.bundleId === app.bundleId && current.pid === app.pid;
  };

  const armTimer = (): void => {
    if (stopped || running || !pending) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, Math.max(0, pending.dueAt - Date.now()));
  };

  const schedule = (app: ForegroundApp, observedAt = Date.now(), waitMs = graceMs): void => {
    if (stopped || app.bundleId.startsWith("com.apple.")) {
      return;
    }
    pending = { app, observedAt, dueAt: Date.now() + waitMs };
    armTimer();
  };

  const drain = async (): Promise<void> => {
    if (stopped || running || !pending) return;
    const work = pending;
    pending = null;
    running = true;
    try {
      const { app, observedAt } = work;
      if (!currentMatches(app)) return;
      if (isFreshForProcess(readFps(udid, app.bundleId), observedAt)) {
        failures.delete(app.bundleId);
        return;
      }
      let failure = failures.get(app.bundleId);
      if (failure && failure.pid !== app.pid) {
        failures.delete(app.bundleId);
        failure = undefined;
      }
      if (failure && failure.count >= MAX_FAILURES) return;
      if (failure && failure.retryAt > Date.now()) {
        schedule(app, observedAt, failure.retryAt - Date.now());
        return;
      }
      const installed = await checkInstalled(udid, app.bundleId);
      if (stopped || !installed || !currentMatches(app)) return;

      const launchedAt = Date.now();
      resetShm(udid);
      const launchedPid = await launch(
        udid,
        app.bundleId,
        environment(udid, app.bundleId),
        () => stopped,
      );
      await delay(verifyMs);
      if (stopped) return;
      if (isFreshForProcess(readFps(udid, app.bundleId), launchedAt)) {
        failures.delete(app.bundleId);
        return;
      }

      const current = tracker.peek(udid);
      const failedPid =
        launchedPid ?? (current?.bundleId === app.bundleId ? current.pid : app.pid);
      const count = (failure?.count ?? 0) + 1;
      failures.set(app.bundleId, { pid: failedPid, count, retryAt: Date.now() + retryMs });
      if (
        current?.bundleId === app.bundleId &&
        current.pid === failedPid &&
        count < MAX_FAILURES
      ) {
        schedule(current, Date.now(), retryMs);
      }
    } catch (error) {
      const app = work.app;
      const previous = failures.get(app.bundleId);
      const count = previous?.pid === app.pid ? previous.count + 1 : 1;
      failures.set(app.bundleId, { pid: app.pid, count, retryAt: Date.now() + retryMs });
      console.error(
        `[serve-sim] FPS probe failed for ${app.bundleId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (count < MAX_FAILURES && currentMatches(app)) schedule(app, Date.now(), retryMs);
    } finally {
      running = false;
      armTimer();
    }
  };

  const subscription = tracker.subscribe(udid, (app) => schedule(app));
  const current = tracker.peek(udid);
  if (current) schedule(current);

  return {
    stop: () => {
      stopped = true;
      pending = null;
      if (timer) clearTimeout(timer);
      timer = null;
      subscription.unsubscribe();
    },
  };
}

const managers = new Map<string, FpsProbeManager>();

export function ensureFpsProbeManager(udid: string): void {
  if (!managers.has(udid)) managers.set(udid, startFpsProbeManager(udid));
}

export function stopFpsProbeManager(udid: string): void {
  managers.get(udid)?.stop();
  managers.delete(udid);
}
