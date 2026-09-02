import { randomUUID } from "crypto";
import { existsSync, promises as fs } from "fs";
import { join, resolve } from "path";
import { setTimeout as sleep } from "timers/promises";
import { debugPasteboard } from "./debug";
import { frontmostAppOf } from "./foreground-tracker";
import { enableCapability } from "./launch-manager";
import { dirnameOf } from "./runtime";
import { simctl } from "./simctl";

// Resolve this path at runtime, not during the Bun build.
const __dirname = dirnameOf(import.meta.url);

export const CLIPBOARD_CAPABILITY = "clipboard";

const INJECTED_TIMEOUT_MS = 1200;
const INJECTED_POLL_MS = 25;
// The trampoline defers its dlopen by a delay we are told not to depend on, so
// give a relaunched app a wide window rather than a tuned one.
const RELAUNCH_TIMEOUT_MS = 8000;

export function locatePasteboardTool(): string | null {
  return locateSimpbArtifact("serve-sim-pasteboard");
}

export function locatePasteboardReaderDylib(): string | null {
  return locateSimpbArtifact("libSimPasteboardReader.dylib");
}

export function locateSimpbArtifact(file: string): string | null {
  const override = process.env.SERVE_SIM_SIMPB_DIR;
  const candidate = [
    ...(override ? [join(override, file)] : []),
    join(__dirname, "..", "dist", "simpb", file),
    join(__dirname, "simpb", file),
  ].find(existsSync);
  return candidate ? resolve(candidate) : null;
}
const SPRINGBOARD_BUNDLE = "com.apple.springboard";

/**
 * A programmatic UIPasteboard read needs the grant; the reader does nothing
 * else. Both places that load the reader call this first.
 */
export async function grantPasteboardAccess(udid: string, bundleId: string): Promise<void> {
  // A denied read returns nil, which the reader writes as "", which is what a
  // genuinely empty clipboard looks like. Swallowing this would make the two
  // indistinguishable, so say when the grant did not go through.
  const failure = await simctl(["privacy", udid, "grant", "pasteboard", bundleId]).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  if (failure) debugPasteboard("pasteboard grant failed for %s on %s: %s", bundleId, udid, failure);
}

const readsInFlight = new Map<string, Promise<string>>();

export function readSimPasteboard(udid: string): Promise<string> {
  const queued = (readsInFlight.get(udid) ?? Promise.resolve())
    .catch(() => {})
    .then(() => readPasteboardOnce(udid));
  readsInFlight.set(udid, queued);
  void queued.catch(() => {}).finally(() => {
    if (readsInFlight.get(udid) === queued) readsInFlight.delete(udid);
  });
  return queued;
}

async function readPasteboardOnce(udid: string): Promise<string> {
  let pbpasteError: unknown;
  if (process.env.SERVE_SIM_SKIP_PBPASTE !== "1") {
    try {
      return await simctl(["pbpaste", udid], {
        env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
      });
    } catch (error: unknown) {
      pbpasteError = error;
    }
  }
  let injectedError: unknown;
  const injected = await readViaInjectedReader(udid).catch((error: unknown) => {
    injectedError = error;
    return null;
  });
  if (injected !== null) return injected;
  const reasons = [
    injectedError instanceof Error
      ? injectedError.message
      : "no frontmost app answered the injected reader",
  ];
  if (pbpasteError instanceof Error) reasons.push(`simctl pbpaste: ${pbpasteError.message}`);
  throw new Error(
    `Could not read the simulator pasteboard on ${udid}. Open the app you copied from and retry. (${reasons.join("; ")})`,
  );
}

async function readViaInjectedReader(udid: string): Promise<string | null> {
  const frontmost = await frontmostAppOf(udid);
  if (!frontmost || frontmost.bundleId === SPRINGBOARD_BUNDLE) return null;
  const bundleId = frontmost.bundleId;

  // System apps like Settings have no data container: get_app_container exits 0
  // and prints "(null)". There is nowhere to exchange files, so relaunching the
  // app would not help.
  const container = (await simctl(["get_app_container", udid, bundleId, "data"])).trim();
  if (!isContainerPath(container)) return null;
  const first = await requestInjectedPasteboard(container);
  if (first !== null) return first;

  const dylib = locatePasteboardReaderDylib();
  if (!dylib) return null;

  // The app started before the reader was armed, so it has no copy of it. The
  // capability loads everywhere, but a dylib can only enter a live process at
  // launch, so this relaunches the one app we need an answer from.
  debugPasteboard("%s did not answer on %s; relaunching it with %s", bundleId, udid, CLIPBOARD_CAPABILITY);
  await grantPasteboardAccess(udid, bundleId);
  await enableCapability(udid, bundleId, { name: CLIPBOARD_CAPABILITY, dylib, allApps: true });
  return requestInjectedPasteboard(container, RELAUNCH_TIMEOUT_MS);
}

/**
 * Read the answer the reader left behind, or null when there isn't one. The
 * reader renames the done file into place, so seeing it means both files are
 * complete.
 */
async function takeInjectedAnswer(
  valuePath: string,
  donePath: string,
): Promise<{ nonce: string; text: string } | null> {
  if (!existsSync(donePath)) return null;
  try {
    const nonce = (await fs.readFile(donePath, "utf-8")).trim();
    const text = await fs.readFile(valuePath, "utf-8");
    return { nonce, text };
  } catch (error: unknown) {
    // A vanished file is the expected race with our own cleanup. Anything else
    // is a real failure that would otherwise surface as "nobody answered".
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT") debugPasteboard("could not read the answer in %s: %s", valuePath, error);
    return null;
  } finally {
    await fs.rm(donePath, { force: true });
    await fs.rm(valuePath, { force: true });
  }
}

/** A real data container, not "(null)" and not a relative path we would write into cwd. */
export function isContainerPath(container: string): boolean {
  return container.startsWith("/");
}

export async function requestInjectedPasteboard(
  container: string,
  timeoutMs = INJECTED_TIMEOUT_MS,
): Promise<string | null> {
  if (!isContainerPath(container)) return null;
  const tmpDir = join(container, "tmp");
  const valuePath = join(tmpDir, "serve-sim-pasteboard.txt");
  const donePath = `${valuePath}.done`;
  const requestPath = join(tmpDir, "serve-sim-pasteboard.request");
  // A request that timed out can still be answered afterwards, and answering it
  // consumes the next request. The nonce tells our answer from that one.
  const nonce = randomUUID();
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.rm(donePath, { force: true });
  await fs.rm(valuePath, { force: true });
  await fs.writeFile(requestPath, nonce);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const answer = await takeInjectedAnswer(valuePath, donePath);
    if (answer?.nonce === nonce) return answer.text;
    if (answer) await fs.writeFile(requestPath, nonce);
    await sleep(INJECTED_POLL_MS);
  }
  await fs.rm(requestPath, { force: true });
  await fs.rm(valuePath, { force: true });
  await fs.rm(donePath, { force: true });
  return null;
}
