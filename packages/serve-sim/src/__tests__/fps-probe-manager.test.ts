import { describe, expect, test } from "bun:test";

import { injectedAppEnvironment } from "../app-injection";
import type {
  ForegroundApp,
  ForegroundTrackerCache,
} from "../foreground-tracker";
import { launchWithProbe, startFpsProbeManager } from "../fps-probe-manager";
import type { FpsSample } from "../fps-shm";

function fakeTracker(initial: ForegroundApp | null = null) {
  let current = initial;
  const listeners = new Set<(app: ForegroundApp) => void>();
  const tracker = {
    peek: () => current,
    subscribe: (_udid: string, listener?: (app: ForegroundApp) => void) => {
      if (listener) listeners.add(listener);
      return { unsubscribe: () => listener && listeners.delete(listener) };
    },
  } as ForegroundTrackerCache;
  return {
    tracker,
    emit(app: ForegroundApp) {
      current = app;
      for (const listener of listeners) listener(app);
    },
  };
}

const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const sample = (timestampMs = Date.now()): FpsSample => ({
  fps: 12,
  mainThreadFps: 60,
  timestampMs,
  maxFps: 60,
});

describe("startFpsProbeManager", () => {
  test("injects the foreground app without a manual command", async () => {
    const foreground = fakeTracker({ bundleId: "dev.expo.A", pid: 11 });
    let currentSample: FpsSample | null = null;
    const launches: Array<{ udid: string; bundleId: string; env: NodeJS.ProcessEnv }> = [];
    const resets: string[] = [];
    const manager = startFpsProbeManager("DEVICE-A", {
      tracker: foreground.tracker,
      readFps: () => currentSample,
      isInstalledApp: async () => true,
      launchEnvironment: () => ({ PROBE: "1" }),
      resetShm: (udid) => {
        resets.push(udid);
        return true;
      },
      launch: async (udid, bundleId, env) => {
        launches.push({ udid, bundleId, env });
        currentSample = sample();
        return 22;
      },
      graceMs: 1,
      verifyMs: 1,
    });

    await wait();
    expect(launches).toEqual([
      { udid: "DEVICE-A", bundleId: "dev.expo.A", env: { PROBE: "1" } },
    ]);
    expect(resets).toEqual(["DEVICE-A"]);
    manager.stop();
  });

  test("does not relaunch a process already producing a fresh sample", async () => {
    const foreground = fakeTracker({ bundleId: "dev.expo.A", pid: 11 });
    let launches = 0;
    const manager = startFpsProbeManager("DEVICE-A", {
      tracker: foreground.tracker,
      readFps: () => sample(),
      isInstalledApp: async () => true,
      launch: async () => {
        launches++;
        return 22;
      },
      graceMs: 1,
      verifyMs: 1,
    });

    await wait();
    expect(launches).toBe(0);
    manager.stop();
  });

  test("ignores the relaunch foreground event after injection", async () => {
    const foreground = fakeTracker({ bundleId: "dev.expo.A", pid: 11 });
    let currentSample: FpsSample | null = null;
    let launches = 0;
    const manager = startFpsProbeManager("DEVICE-A", {
      tracker: foreground.tracker,
      readFps: () => currentSample,
      isInstalledApp: async () => true,
      launchEnvironment: () => ({}),
      launch: async () => {
        launches++;
        foreground.emit({ bundleId: "dev.expo.A", pid: 22 });
        currentSample = sample();
        return 22;
      },
      graceMs: 1,
      verifyMs: 1,
    });

    await wait();
    expect(launches).toBe(1);
    manager.stop();
  });

  test("skips system apps and bundles without an app container", async () => {
    const foreground = fakeTracker({ bundleId: "com.apple.mobilesafari", pid: 11 });
    let launches = 0;
    const manager = startFpsProbeManager("DEVICE-A", {
      tracker: foreground.tracker,
      readFps: () => null,
      isInstalledApp: async () => false,
      launch: async () => {
        launches++;
        return 22;
      },
      graceMs: 1,
      verifyMs: 1,
    });
    foreground.emit({ bundleId: "dev.expo.Missing", pid: 12 });

    await wait();
    expect(launches).toBe(0);
    manager.stop();
  });

  test("keeps devices isolated", async () => {
    const a = fakeTracker({ bundleId: "dev.expo.A", pid: 11 });
    const b = fakeTracker({ bundleId: "dev.expo.B", pid: 22 });
    const launches: string[] = [];
    const deps = (tracker: ForegroundTrackerCache) => ({
      tracker,
      readFps: () => null,
      isInstalledApp: async () => true,
      launchEnvironment: () => ({}),
      launch: async (udid: string) => {
        launches.push(udid);
        return 99;
      },
      graceMs: 1,
      verifyMs: 1,
      retryMs: 1000,
    });
    const managerA = startFpsProbeManager("DEVICE-A", deps(a.tracker));
    const managerB = startFpsProbeManager("DEVICE-B", deps(b.tracker));

    await wait();
    expect(launches.sort()).toEqual(["DEVICE-A", "DEVICE-B"]);
    managerA.stop();
    managerB.stop();
  });

  test("allows a new process to recover after an injection failure", async () => {
    const foreground = fakeTracker({ bundleId: "dev.expo.A", pid: 11 });
    let launches = 0;
    const manager = startFpsProbeManager("DEVICE-A", {
      tracker: foreground.tracker,
      readFps: () => null,
      isInstalledApp: async () => true,
      launchEnvironment: () => ({}),
      resetShm: () => true,
      launch: async () => {
        launches++;
        return null;
      },
      graceMs: 1,
      verifyMs: 1,
      retryMs: 1000,
    });

    await wait();
    foreground.emit({ bundleId: "dev.expo.A", pid: 12 });
    await wait();
    expect(launches).toBe(2);
    manager.stop();
  });

  test("backs off when the injected process does not publish a sample", async () => {
    const foreground = fakeTracker({ bundleId: "dev.expo.A", pid: 11 });
    let launches = 0;
    const manager = startFpsProbeManager("DEVICE-A", {
      tracker: foreground.tracker,
      readFps: () => null,
      isInstalledApp: async () => true,
      launchEnvironment: () => ({}),
      resetShm: () => true,
      launch: async () => {
        launches++;
        foreground.emit({ bundleId: "dev.expo.A", pid: 22 });
        return 22;
      },
      graceMs: 1,
      verifyMs: 1,
      retryMs: 100,
    });

    await wait();
    expect(launches).toBe(1);
    manager.stop();
  });

  test("does not launch after it stops during the app check", async () => {
    const foreground = fakeTracker({ bundleId: "dev.expo.A", pid: 11 });
    let finishCheck!: (installed: boolean) => void;
    let launches = 0;
    const manager = startFpsProbeManager("DEVICE-A", {
      tracker: foreground.tracker,
      readFps: () => null,
      isInstalledApp: () => new Promise((resolve) => {
        finishCheck = resolve;
      }),
      launch: async () => {
        launches++;
        return 22;
      },
      graceMs: 1,
      verifyMs: 1,
    });

    await wait(10);
    manager.stop();
    finishCheck(true);
    await wait(10);
    expect(launches).toBe(0);
  });

  test("cancels between termination and launch", async () => {
    let stopped = false;
    let finishTermination!: () => void;
    const calls: string[][] = [];
    const launch = launchWithProbe("DEVICE-A", "dev.expo.A", {}, () => stopped, async (args) => {
      calls.push(args);
      if (args[1] === "terminate") {
        await new Promise<void>((resolve) => {
          finishTermination = resolve;
        });
      }
      return { stdout: "dev.expo.A: 22" };
    });

    await wait();
    stopped = true;
    finishTermination();
    expect(await launch).toBeNull();
    expect(calls).toEqual([["simctl", "terminate", "DEVICE-A", "dev.expo.A"]]);
  });
});

describe("injectedAppEnvironment", () => {
  test("chains FPS and camera injection", () => {
    const env = injectedAppEnvironment({
      fps: { dylib: "/fps.dylib", shmName: "/fps-shm" },
      camera: { dylib: "/camera.dylib", shmName: "/camera-shm", mirror: "off" },
    });

    expect(env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES).toBe(
      "/fps.dylib:/camera.dylib",
    );
    expect(env.SIMCTL_CHILD_SERVE_SIM_FPS_SHM).toBe("/fps-shm");
    expect(env.SIMCTL_CHILD_SIMCAM_SHM_NAME).toBe("/camera-shm");
    expect(env.SIMCTL_CHILD_SIMCAM_MIRROR_MODE).toBe("off");
  });
});
