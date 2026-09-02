import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { registerCapability } from "./capabilities";
import { trampolineDir } from "./launch-manager";

export function probeSampleFilePath(udid: string): string {
  return join(tmpdir(), `serve-sim-probe-${udid}.txt`);
}

export function registerBuiltinCapabilities(): void {
  registerCapability({
    name: "probe",
    defaultEnabled: false,
    async resolve(udid) {
      const dylib = join(trampolineDir(), "libServeSimProbe.dylib");
      if (!existsSync(dylib)) return null;
      return { name: "probe", dylib, env: { SERVE_SIM_PROBE_FILE: probeSampleFilePath(udid) } };
    },
  });
}
