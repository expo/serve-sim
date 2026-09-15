import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";

type HostDependencies = {
  exists: (path: string) => boolean;
  run: (file: string, args: string[]) => string;
};

const dependencies: HostDependencies = {
  exists: existsSync,
  run: (file, args) => execFileSync(file, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 3_000,
  }),
};

/** Resolve inside the selected Xcode so side-by-side installs cannot open the wrong host. */
export function resolveSimulatorHost(developerDir: string, exists: (path: string) => boolean = existsSync) {
  // xcode-select -p honors DEVELOPER_DIR, which may name the .app itself.
  const selected = resolve(developerDir.trim());
  const dev = selected.endsWith(".app")
    ? join(selected, "Contents", "Developer")
    : selected;
  const deviceHub = resolve(dev, "../Applications/DeviceHub.app");
  if (exists(deviceHub)) return { kind: "device-hub" as const, path: deviceHub };
  const simulator = join(dev, "Applications/Simulator.app");
  if (exists(simulator)) return { kind: "simulator" as const, path: simulator };
  throw new Error(
    `Neither Device Hub nor Simulator was found in ${dev}. Select a full Xcode installation with DEVELOPER_DIR or xcode-select, then retry.`,
  );
}

/** Start the display pipeline in the background, with a bounded wait for headless hosts. */
export function openSimulatorHost(udid: string, deps: HostDependencies = dependencies): void {
  const developerDir = deps.run("/usr/bin/xcode-select", ["-p"]).trim();
  if (!developerDir) {
    throw new Error("xcode-select returned no developer directory. Select a full Xcode installation and retry.");
  }
  const host = resolveSimulatorHost(developerDir, deps.exists);
  const args = ["-g", "-a", host.path];
  if (udid) {
    if (host.kind === "device-hub") {
      args.push(`devices://device/open?id=${encodeURIComponent(udid)}`);
    } else {
      args.push("--args", "-CurrentDeviceUDID", udid);
    }
  }
  deps.run("/usr/bin/open", args);
}
