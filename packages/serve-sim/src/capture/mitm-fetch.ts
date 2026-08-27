import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * TEMPORARY — remote-session testing only. Do not merge.
 *
 * EAS workers have no mitmproxy, and serve-sim is the only thing we control inside a session, so this
 * fetches a pinned standalone build on demand. Real provisioning belongs in the build-tools step that
 * launches serve-sim, not in serve-sim itself.
 */
const VERSION = "12.2.3";
const ARCHIVE = `mitmproxy-${VERSION}-macos-arm64.tar.gz`;
const URL = `https://downloads.mitmproxy.org/${VERSION}/${ARCHIVE}`;

export function fetchMitmdumpIfAllowed(log: (message: string) => void): string | null {
  // TEMP (test branch): unconditional, because we cannot rely on env reaching the EAS worker.
  const root = join(tmpdir(), `serve-sim-mitmproxy-${VERSION}`);
  // The macOS archive is an app bundle, the same shape locateMitmdump already looks for.
  const mitmdump = join(root, "mitmproxy.app", "Contents", "MacOS", "mitmdump");
  if (existsSync(mitmdump)) return mitmdump;

  mkdirSync(root, { recursive: true });
  log(`Network capture: fetching mitmproxy ${VERSION} (54MB) because the host has none.`);
  const archive = join(root, ARCHIVE);
  const curl = spawnSync("curl", ["-fsSL", "-o", archive, URL], { timeout: 180_000, encoding: "utf8" });
  if (curl.status !== 0) {
    log(`Network capture: downloading mitmproxy failed: ${curl.stderr?.trim() ?? curl.status}`);
    return null;
  }
  const tar = spawnSync("tar", ["-xzf", archive, "-C", root], { timeout: 120_000, encoding: "utf8" });
  if (tar.status !== 0) {
    log(`Network capture: unpacking mitmproxy failed: ${tar.stderr?.trim() ?? tar.status}`);
    return null;
  }
  if (!existsSync(mitmdump)) {
    log(`Network capture: ${ARCHIVE} did not contain a mitmdump executable.`);
    return null;
  }
  spawnSync("xattr", ["-d", "com.apple.quarantine", mitmdump], { encoding: "utf8" });
  log(`Network capture: using ${mitmdump}`);
  return mitmdump;
}
