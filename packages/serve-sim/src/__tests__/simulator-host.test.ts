import { describe, expect, it } from "bun:test";
import { openSimulatorHost, resolveSimulatorHost } from "../simulator-host";

const dev = "/Applications/Xcode Selected.app/Contents/Developer";
const simulator = `${dev}/Applications/Simulator.app`;
const hub = "/Applications/Xcode Selected.app/Contents/Applications/DeviceHub.app";

describe("simulator host selection", () => {
  it("resolves the Xcode 26 layout", () => {
    expect(resolveSimulatorHost(dev, path => path === simulator)).toEqual({
      kind: "simulator", path: simulator,
    });
  });

  it("resolves the Xcode 27 layout", () => {
    expect(resolveSimulatorHost(dev, path => path === hub)).toEqual({
      kind: "device-hub", path: hub,
    });
  });

  it("accepts an app-bundle DEVELOPER_DIR with trailing whitespace and slash", () => {
    expect(resolveSimulatorHost("/Applications/Xcode Selected.app/\n", path => path === hub).path).toBe(hub);
  });

  it("prefers Device Hub if the selected Xcode contains both hosts", () => {
    expect(resolveSimulatorHost(dev, path => [hub, simulator].includes(path)).kind).toBe("device-hub");
  });

  it("does not fall back to a different installed Xcode", () => {
    expect(() => resolveSimulatorHost(dev, path => path === "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app"))
      .toThrow("Select a full Xcode installation");
  });
});

describe("opening the simulator host", () => {
  function launch(installed: string, udid = "device-id") {
    const calls: [string, string[]][] = [];
    openSimulatorHost(udid, {
      exists: path => path === installed,
      run: (file, args) => {
        calls.push([file, args]);
        return file === "/usr/bin/xcode-select" ? `${dev}\n` : "";
      },
    });
    expect(calls[0]).toEqual(["/usr/bin/xcode-select", ["-p"]]);
    return calls[1];
  }

  it("opens the selected Simulator in the background with its device argument", () => {
    expect(launch(simulator)).toEqual([
      "/usr/bin/open", ["-g", "-a", simulator, "--args", "-CurrentDeviceUDID", "device-id"],
    ]);
  });

  it("targets the selected Device Hub explicitly when opening its device URL", () => {
    expect(launch(hub)).toEqual([
      "/usr/bin/open", ["-g", "-a", hub, "devices://device/open?id=device-id"],
    ]);
  });

  it("encodes device identifiers as a single URL parameter", () => {
    expect(launch(hub, "id&other=value")?.[1].at(-1)).toBe("devices://device/open?id=id%26other%3Dvalue");
  });

  it("opens either host without device arguments when no device was supplied", () => {
    for (const host of [hub, simulator]) {
      expect(launch(host, "")).toEqual(["/usr/bin/open", ["-g", "-a", host]]);
    }
  });

  it("rejects empty xcode-select output before probing or opening an app", () => {
    expect(() => openSimulatorHost("id", {
      run: () => "\n",
      exists: () => { throw new Error("should not probe"); },
    })).toThrow("xcode-select returned no developer directory");
  });

  it("preserves launch errors for the caller's headless-host handling", () => {
    expect(() => openSimulatorHost("id", {
      exists: path => path === hub,
      run: file => {
        if (file === "/usr/bin/xcode-select") return dev;
        throw new Error("window server unavailable");
      },
    })).toThrow("window server unavailable");
  });
});
