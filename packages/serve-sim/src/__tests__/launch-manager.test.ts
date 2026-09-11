import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import {
  type RecordedCapability,
  MAX_CONFIG_BYTES,
  childLaunchEnv,
  clearLaunchState,
  formatCapabilityConfig,
  isCapabilityEnabled,
  listCapabilities,
  readLaunchState,
  releaseLaunchState,
  renderCapabilityConfig,
} from "../launch-manager";
import { stateDir } from "../state";
import { useTempStateDir } from "./helpers";

const UDID = "LAUNCH-MANAGER-TEST-" + process.pid;

let tempState: { dir: string; restore(): void };

beforeAll(() => {
  tempState = useTempStateDir();
});

afterAll(() => {
  tempState.restore();
});

function writeRawState(contents: string): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(join(stateDir(), `launch-${UDID}.json`), contents);
}

afterEach(() => {
  clearLaunchState(UDID);
});

describe("formatCapabilityConfig", () => {
  test("writes one tab-separated line per capability", () => {
    expect(
      formatCapabilityConfig({
        camera: {
          name: "camera",
          bundleId: "host.exp.Exponent",
          scope: "allApps",
          dylib: "/dist/simcam/libSimCameraInjector.dylib",
          ownerPid: null,
          loadDelayMs: 500,
          env: { SIMCAM_SHM_NAME: "/serve-sim-cam-1", SIMCAM_MIRROR_MODE: "on" },
        },
      }),
    ).toBe(
      "all\t/dist/simcam/libSimCameraInjector.dylib" +
        "\tSIMCAM_SHM_NAME=/serve-sim-cam-1;SIMCAM_MIRROR_MODE=on\t500\n",
    );
  });

  test("keeps every capability so enabling one never evicts another", () => {
    const config = formatCapabilityConfig({
      camera: {
        name: "camera",
        bundleId: "a",
        scope: "allApps",
        dylib: "/cam.dylib",
        ownerPid: null,
        loadDelayMs: 500,
      },
      fps: { name: "fps", bundleId: "a", scope: "allApps", dylib: "/fps.dylib", env: { SERVE_SIM_FPS_FILE: "/f" }, ownerPid: null },
    });
    expect(config.trim().split("\n")).toEqual([
      "all\t/cam.dylib\t\t500",
      "all\t/fps.dylib\tSERVE_SIM_FPS_FILE=/f\t0",
    ]);
  });

  test("is empty when nothing is enabled", () => {
    expect(formatCapabilityConfig({})).toBe("");
  });
});

describe("readLaunchState", () => {
  test("returns null when nothing was recorded", () => {
    expect(readLaunchState(UDID)).toBeNull();
  });

  test("reads the bundle, its arguments and its capabilities", () => {
    writeRawState(
      JSON.stringify({
        bundleId: "host.exp.Exponent",
        launchArgs: ["-EXDevMenuIsOnboardingFinished", "1"],
        capabilities: {
          "host.exp.Exponent:camera": {
            name: "camera",
            bundleId: "host.exp.Exponent",
            scope: "allApps",
            dylib: "/cam.dylib",
            ownerPid: null,
          },
        },
      }),
    );
    const state = readLaunchState(UDID);
    expect(state?.bundleId).toBe("host.exp.Exponent");
    expect(state?.launchArgs).toEqual(["-EXDevMenuIsOnboardingFinished", "1"]);
    expect(Object.keys(state?.capabilities ?? {})).toEqual(["host.exp.Exponent:camera"]);
  });

  test("defaults the arguments and capabilities when they are absent", () => {
    writeRawState(JSON.stringify({ bundleId: "host.exp.Exponent" }));
    expect(readLaunchState(UDID)).toEqual({
      bundleId: "host.exp.Exponent",
      launchArgs: [],
      capabilities: {},
    });
  });

  test("returns null for a file that is not JSON", () => {
    writeRawState("not json");
    expect(readLaunchState(UDID)).toBeNull();
  });
});

describe("config size limit", () => {
  const huge: Record<string, RecordedCapability> = {
    huge: {
      name: "huge",
      bundleId: "a",
      scope: "allApps",
      dylib: "/huge.dylib",
      ownerPid: null,
      env: { BIG: "x".repeat(70_000) },
    },
  };

  test("a capability set that would not fit is refused", () => {
    expect(() =>
      renderCapabilityConfig({ launchArgs: [], capabilities: huge }),
    ).toThrow("The capability loader would load nothing");
  });

  test("a capability set that fits is rendered", () => {
    expect(
      renderCapabilityConfig({
        launchArgs: [],
        capabilities: {
          small: {
            name: "small",
            bundleId: "a",
            scope: "allApps",
            dylib: "/small.dylib",
            ownerPid: null,
          },
        },
      }),
    ).toBe("all\t/small.dylib\t\t0\n");
  });

  test("refuses a config the capability loader could not read", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../Sources/ServeSimCapabilityLoader/serve-sim-capability-loader.c"),
      "utf-8",
    );
    const compiled = source.match(/#define MAX_CONFIG_BYTES \((\d+) \* (\d+)\)/);
    expect(compiled).not.toBeNull();
    expect(Number(compiled![1]) * Number(compiled![2])).toBe(MAX_CONFIG_BYTES);
  });
});

describe("childLaunchEnv", () => {
  test("inserts the capability dylib and the capability loader into the launched app", () => {
    const env = childLaunchEnv("/opt/injector.dylib", { SIMCAM_SHM_NAME: "/shm" });
    const inserted = env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES!.split(":");

    expect(inserted).toContain("/opt/injector.dylib");
    expect(inserted.some((path) => path.endsWith("libServeSimCapabilityLoader.dylib"))).toBe(true);
  });

  test("prefixes the capability environment so simctl passes it to the app", () => {
    expect(childLaunchEnv("/opt/injector.dylib", { SIMCAM_SHM_NAME: "/shm" })).toMatchObject({
      SIMCTL_CHILD_SIMCAM_SHM_NAME: "/shm",
    });
  });
});

describe("config field separators", () => {
  test("a value carrying a separator is refused", () => {
    for (const value of ["a\tb", "a\nb", "a;b"]) {
      expect(() =>
        formatCapabilityConfig({
          "x": { name: "x", bundleId: "a", scope: "allApps", dylib: "/x.dylib", env: { K: value }, ownerPid: null },
        }),
      ).toThrow("separates fields");
    }
  });

  test("a name carrying the pair separator is refused", () => {
    expect(() =>
      formatCapabilityConfig({
        "x": { name: "x", bundleId: "a", scope: "allApps", dylib: "/x.dylib", env: { "K=V": "1" }, ownerPid: null },
      }),
    ).toThrow('contains "="');
  });
});

describe("querying what is enabled", () => {
  test("reports the capabilities recorded for the device", () => {
    writeRawState(
      JSON.stringify({
        bundleId: "host.exp.Exponent",
        launchArgs: [],
        capabilities: {
          camera: {
            name: "camera",
            bundleId: "host.exp.Exponent",
            scope: "allApps",
            dylib: "/cam.dylib",
            ownerPid: null,
          },
          capture: {
            name: "capture",
            bundleId: null,
            scope: "userApps",
            dylib: "/cap.dylib",
            ownerPid: null,
          },
        },
      }),
    );
    expect(isCapabilityEnabled(UDID, "camera")).toBe(true);
    expect(isCapabilityEnabled(UDID, "clipboard")).toBe(false);
    expect(listCapabilities(UDID)).toEqual(["camera", "capture"]);
  });

  test("reports nothing for a device with no recorded state", () => {
    expect(isCapabilityEnabled(UDID, "camera")).toBe(false);
    expect(listCapabilities(UDID)).toEqual([]);
  });
});

describe("capability scopes", () => {
  test("each scope writes the token the capability loader matches on", () => {
    const config = formatCapabilityConfig({
      clipboard: {
        name: "clipboard",
        bundleId: null,
        scope: "allApps",
        dylib: "/reader.dylib",
        ownerPid: null,
      },
      capture: {
        name: "capture",
        bundleId: null,
        scope: "userApps",
        dylib: "/cap.dylib",
        ownerPid: null,
        loadDelayMs: 250,
      },
    });
    expect(config.split("\n").filter(Boolean)).toEqual([
      "all\t/reader.dylib\t\t0",
      "user\t/cap.dylib\t\t250",
    ]);
  });

  test("a record with an unreadable scope is dropped", () => {
    writeRawState(
      JSON.stringify({
        launchArgs: [],
        capabilities: {
          camera: { name: "camera", bundleId: null, scope: "everything", dylib: "/cam.dylib", ownerPid: null },
        },
      }),
    );
    expect(listCapabilities(UDID)).toEqual([]);
  });
});

describe("state without a launched app", () => {
  test("is readable, so capabilities can exist before anything is launched", () => {
    writeRawState(JSON.stringify({ launchArgs: [], capabilities: {} }));
    expect(readLaunchState(UDID)).toEqual({ launchArgs: [], capabilities: {} });
  });
});

describe("releaseLaunchState", () => {
  const record = (ownerPid: number | null) => ({
    name: "probe",
    bundleId: "a",
    scope: "allApps",
    dylib: "/probe.dylib",
    ownerPid,
  });

  test("keeps a record another live session owns", () => {
    writeRawState(
      JSON.stringify({
        launchArgs: [],
        capabilities: { probe: record(process.pid), other: { ...record(process.ppid), name: "other" } },
      }),
    );

    expect(releaseLaunchState(UDID, process.pid)).toBe(true);
    expect(listCapabilities(UDID)).toEqual(["other"]);
  });

  test("reports nothing left when only our records were there", () => {
    writeRawState(
      JSON.stringify({ launchArgs: [], capabilities: { probe: record(process.pid) } }),
    );

    expect(releaseLaunchState(UDID, process.pid)).toBe(false);
    expect(readLaunchState(UDID)).toBeNull();
  });

  test("keeps a record no session owns, so a one-shot command survives", () => {
    writeRawState(
      JSON.stringify({ launchArgs: [], capabilities: { probe: record(null) } }),
    );

    expect(releaseLaunchState(UDID, process.pid)).toBe(true);
    expect(listCapabilities(UDID)).toEqual(["probe"]);
  });

  test("drops a record whose owner died without disarming", () => {
    const dead = 999_999;
    writeRawState(
      JSON.stringify({ launchArgs: [], capabilities: { probe: record(dead) } }),
    );

    expect(listCapabilities(UDID)).toEqual([]);
  });
});
