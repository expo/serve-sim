import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { registerCapability } from "./capabilities";
import { trampolineDir } from "./launch-manager";
import {
  CLIPBOARD_CAPABILITY,
  grantPasteboardAccess,
  locatePasteboardReaderDylib,
} from "./sim-pasteboard";

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

  // `simctl pbpaste` covers a GUI Mac; the reader covers headless workers, where
  // it segfaults. It loads everywhere because its target is whichever app is
  // frontmost when the user clicks Copy, which no session start can predict.
  registerCapability({
    name: CLIPBOARD_CAPABILITY,
    defaultEnabled: true,
    async resolve(udid, bundleId) {
      const dylib = locatePasteboardReaderDylib();
      if (!dylib) return null;
      if (bundleId) await grantPasteboardAccess(udid, bundleId);
      return { name: CLIPBOARD_CAPABILITY, dylib, allApps: true };
    },
  });
}
