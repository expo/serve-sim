import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import {
  clearLaunchState,
  formatCapabilityConfig,
  isCapabilityEnabled,
  listCapabilities,
  readLaunchState,
} from "../launch-manager";
import { STATE_DIR } from "../state";

const UDID = "LAUNCH-MANAGER-TEST-" + process.pid;

function writeRawState(contents: string): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, `launch-${UDID}.json`), contents);
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
          container: "/Containers/Data/Application/AAAA",
          dylib: "/dist/simcam/libSimCameraInjector.dylib",
          env: { SIMCAM_SHM_NAME: "/serve-sim-cam-1", SIMCAM_MIRROR_MODE: "on" },
        },
      }),
    ).toBe(
      "/Containers/Data/Application/AAAA\t/dist/simcam/libSimCameraInjector.dylib" +
        "\tSIMCAM_SHM_NAME=/serve-sim-cam-1;SIMCAM_MIRROR_MODE=on\n",
    );
  });

  test("keeps every capability so enabling one never evicts another", () => {
    const config = formatCapabilityConfig({
      camera: { name: "camera", bundleId: "a", container: "/c/A", dylib: "/cam.dylib" },
      fps: { name: "fps", bundleId: "a", container: "/c/A", dylib: "/fps.dylib", env: { SERVE_SIM_FPS_FILE: "/f" } },
    });
    expect(config.trim().split("\n")).toEqual([
      "/c/A\t/cam.dylib\t",
      "/c/A\t/fps.dylib\tSERVE_SIM_FPS_FILE=/f",
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
            container: "/c/A",
            dylib: "/cam.dylib",
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
  test("a capability set that would not fit is refused, not truncated", () => {
    const oversized = formatCapabilityConfig({
      "a:huge": {
        name: "huge",
        bundleId: "a",
        container: "/c/A",
        dylib: "/huge.dylib",
        env: { BIG: "x".repeat(70_000) },
      },
    });
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThanOrEqual(64 * 1024 - 1);
  });
});

describe("querying what is enabled", () => {
  test("answers per app without exposing the key format", () => {
    writeRawState(
      JSON.stringify({
        bundleId: "host.exp.Exponent",
        launchArgs: [],
        capabilities: {
          "host.exp.Exponent:camera": {
            name: "camera",
            bundleId: "host.exp.Exponent",
            container: "/c/A",
            dylib: "/cam.dylib",
          },
          "com.apple.mobilesafari:fps": {
            name: "fps",
            bundleId: "com.apple.mobilesafari",
            container: "/c/B",
            dylib: "/fps.dylib",
          },
        },
      }),
    );
    expect(isCapabilityEnabled(UDID, "host.exp.Exponent", "camera")).toBe(true);
    expect(isCapabilityEnabled(UDID, "host.exp.Exponent", "fps")).toBe(false);
    expect(listCapabilities(UDID, "host.exp.Exponent")).toEqual(["camera"]);
    expect(listCapabilities(UDID, "com.apple.mobilesafari")).toEqual(["fps"]);
  });

  test("reports nothing for a device with no recorded state", () => {
    expect(isCapabilityEnabled(UDID, "host.exp.Exponent", "camera")).toBe(false);
    expect(listCapabilities(UDID, "host.exp.Exponent")).toEqual([]);
  });
});

describe("wildcard capabilities", () => {
  test("a capability for every app is written without a container", () => {
    const config = formatCapabilityConfig({
      "*:clipboard": {
        name: "clipboard",
        bundleId: null,
        container: "",
        dylib: "/reader.dylib",
        allApps: true,
      },
      "host.exp.Exponent:camera": {
        name: "camera",
        bundleId: "host.exp.Exponent",
        container: "/c/A",
        dylib: "/cam.dylib",
      },
    });
    expect(config.split("\n").filter(Boolean)).toEqual([
      "\t/reader.dylib\t",
      "/c/A\t/cam.dylib\t",
    ]);
  });

  test("is reported against any app", () => {
    writeRawState(
      JSON.stringify({
        launchArgs: [],
        capabilities: {
          "*:clipboard": {
            name: "clipboard",
            bundleId: null,
            container: "",
            dylib: "/reader.dylib",
            allApps: true,
          },
        },
      }),
    );
    expect(listCapabilities(UDID, "anything.at.all")).toEqual(["clipboard"]);
    expect(isCapabilityEnabled(UDID, "anything.at.all", "clipboard")).toBe(true);
    expect(readLaunchState(UDID)?.bundleId).toBeUndefined();
  });
});

describe("state without a launched app", () => {
  test("is readable, so capabilities can exist before anything is launched", () => {
    writeRawState(JSON.stringify({ launchArgs: [], capabilities: {} }));
    expect(readLaunchState(UDID)).toEqual({ launchArgs: [], capabilities: {} });
  });
});
