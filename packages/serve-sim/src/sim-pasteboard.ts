import { execFile } from "child_process";
import { existsSync, promises as fs } from "fs";
import { join, resolve } from "path";
import { promisify } from "util";
import { frontmostAppViaAx } from "./foreground-tracker";
import { dirnameOf } from "./runtime";

const execFileAsync = promisify(execFile);

// Bun's bundler inlines a bare `__dirname` as the build machine's source
// directory; shadow it with the runtime location so the published bundle finds
// dist/simpb next to itself (same pattern as ui-settings.ts).
const __dirname = dirnameOf(import.meta.url);

export const PASTEBOARD_APP_BUNDLE_ID = "dev.expo.serve-sim.pasteboard";

const READ_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 100;

export function locatePasteboardTool(): string | null {
  return firstExisting([
    join(__dirname, "..", "dist", "simpb", "serve-sim-pasteboard"),
    join(__dirname, "simpb", "serve-sim-pasteboard"),
  ]);
}

export function locatePasteboardApp(): string | null {
  return firstExisting([
    join(__dirname, "..", "dist", "simpb", "ServeSimPasteboard.app"),
    join(__dirname, "simpb", "ServeSimPasteboard.app"),
  ]);
}

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) if (existsSync(candidate)) return resolve(candidate);
  return null;
}

async function simctl(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", ...args], { encoding: "utf-8" });
  return stdout;
}

/**
 * Reads the simulator pasteboard through the bundled reader app.
 *
 * `simctl pbpaste` bridges through the host pasteboard and needs a GUI login
 * session, so it crashes on headless hosts such as EAS workers. iOS only serves
 * pasteboard contents to a foreground app, so the read runs in a real app that
 * is launched, read from, and closed again. The frontmost app is restored
 * afterwards so the switch is a flicker rather than a navigation.
 */
export async function readSimPasteboard(udid: string): Promise<string> {
  // The host bridge is instant and does not disturb the foreground app, so
  // prefer it and fall back only where it cannot work.
  try {
    return await simctl(["pbpaste", udid]);
  } catch {
    return await readSimPasteboardViaApp(udid);
  }
}

// `simctl install` costs seconds, so the install, the TCC grant and the
// container lookup are done once per device and reused. Keyed by udid; a
// simulator that is erased or reset resolves again through the retry below.
const readerSetups = new Map<string, Promise<string>>();

async function prepareReader(udid: string): Promise<string> {
  const app = locatePasteboardApp();
  if (!app) throw new Error("Pasteboard reader app is missing from this build");

  const container = (
    await simctl(["get_app_container", udid, PASTEBOARD_APP_BUNDLE_ID, "data"]).catch(async () => {
      await simctl(["install", udid, app]);
      return simctl(["get_app_container", udid, PASTEBOARD_APP_BUNDLE_ID, "data"]);
    })
  ).trim();
  if (!container) throw new Error("Could not locate the pasteboard reader container");

  // Without this grant iOS shows a consent alert and the read blocks on it.
  await simctl(["privacy", udid, "grant", "pasteboard", PASTEBOARD_APP_BUNDLE_ID]);
  return container;
}

function readerContainer(udid: string): Promise<string> {
  let setup = readerSetups.get(udid);
  if (!setup) {
    setup = prepareReader(udid).catch((error: unknown) => {
      readerSetups.delete(udid);
      throw error;
    });
    readerSetups.set(udid, setup);
  }
  return setup;
}

export async function readSimPasteboardViaApp(udid: string): Promise<string> {
  const [container, previous] = await Promise.all([
    readerContainer(udid),
    frontmostAppViaAx(udid).catch(() => null),
  ]);

  const valuePath = join(container, "Documents", "pasteboard.txt");
  const donePath = join(container, "Documents", "done");
  await fs.rm(donePath, { force: true });
  await fs.rm(valuePath, { force: true });

  try {
    await simctl(["launch", udid, PASTEBOARD_APP_BUNDLE_ID]);
    const deadline = Date.now() + READ_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (existsSync(donePath)) return await fs.readFile(valuePath, "utf-8");
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error("Timed out reading the simulator pasteboard");
  } finally {
    // The reader exits once it has written, so only the previous app needs
    // restoring — and SpringBoard is where exiting already leaves us.
    const restore = previous?.bundleId;
    if (restore && restore !== PASTEBOARD_APP_BUNDLE_ID && restore !== "com.apple.springboard") {
      await simctl(["launch", udid, restore]).catch(() => {});
    }
  }
}
