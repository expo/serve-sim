import { execFileSync } from "child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";

import { capabilitiesToApply, type CapabilityOverrides } from "./capabilities";
import { dirnameOf } from "./runtime";
import { simctl as runSimctl } from "./simctl";
import { STATE_DIR } from "./state";

const CONFIG_NAME = "capabilities.conf";
const TRAMPOLINE_NAME = "libServeSimTrampoline.dylib";
// Must match, and stay one under, MAX_CONFIG_BYTES in Sources/ServeSimTrampoline.
const MAX_CONFIG_BYTES = 64 * 1024;
const TERMINATE_TIMEOUT_MS = 15_000;

export interface Capability {
  name: string;
  dylib: string;
  env?: Record<string, string>;
  /** Load in every app rather than one. The config line carries no container. */
  allApps?: boolean;
}

interface LaunchState {
  bundleId?: string;
  launchArgs: string[];
  capabilities: Record<string, Capability & { bundleId: string | null; container: string }>;
}

function stateFile(udid: string): string {
  return join(STATE_DIR, `launch-${udid}.json`);
}

export function readLaunchState(udid: string): LaunchState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(stateFile(udid), "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { bundleId, launchArgs, capabilities } = parsed as Partial<LaunchState>;
  return {
    ...(typeof bundleId === "string" && bundleId ? { bundleId } : {}),
    launchArgs: Array.isArray(launchArgs)
      ? launchArgs.filter((arg): arg is string => typeof arg === "string")
      : [],
    capabilities: typeof capabilities === "object" && capabilities !== null ? capabilities : {},
  };
}

export function clearLaunchState(udid: string): void {
  try { unlinkSync(stateFile(udid)); } catch {}
}

function writeLaunchState(udid: string, state: LaunchState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(stateFile(udid), JSON.stringify(state));
}

export function trampolineDir(): string {
  return join(dirnameOf(import.meta.url), "..", "dist", "trampoline");
}

export function formatCapabilityConfig(
  capabilities: Record<string, Capability & { bundleId: string | null; container: string }>,
): string {
  const lines = Object.values(capabilities).map((capability) => {
    const env = Object.entries(capability.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join(";");
    return [capability.container, capability.dylib, env].join("\t");
  });
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function renderCapabilityConfig(state: LaunchState): string {
  const contents = formatCapabilityConfig(state.capabilities);
  const size = Buffer.byteLength(contents, "utf8");
  if (size >= MAX_CONFIG_BYTES - 1) {
    throw new Error(
      `Capability config is ${size} bytes, over the ${MAX_CONFIG_BYTES} byte limit the trampoline ` +
        `can read. It would load some capabilities and drop others. Disable capabilities you are ` +
        `not using, or shorten the environment values passed to them.`,
    );
  }
  return contents;
}

function commitCapabilityConfig(contents: string): void {
  const dir = trampolineDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = join(dir, CONFIG_NAME);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, contents);
  renameSync(temp, target);
}

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 50;

function lockFile(udid: string): string {
  return join(STATE_DIR, `launch-${udid}.lock`);
}

function lockHolderIsGone(path: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(path, "utf-8").trim());
  } catch {
    return true;
  }
  if (!Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function withLaunchStateLock<T>(udid: string, fn: () => Promise<T>): Promise<T> {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const path = lockFile(udid);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | undefined;

  while (fd === undefined) {
    try {
      fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid));
    } catch {
      if (lockHolderIsGone(path)) {
        try { unlinkSync(path); } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting to update the launch state for ${udid}. Another serve-sim command ` +
            `is holding ${path}. Wait for it to finish, or remove that file if nothing is running.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  try {
    return await fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(path); } catch {}
  }
}

async function simctl(args: string[], timeout = 30_000): Promise<string> {
  return (await runSimctl(args, { timeout })).trim();
}

async function containerForBundle(udid: string, bundleId: string): Promise<string> {
  const container = await simctl(["get_app_container", udid, bundleId, "data"]);
  if (!container.startsWith("/")) {
    throw new Error(
      `${bundleId} has no data container on ${udid}, so a capability cannot be matched to it ` +
        `(simctl reported "${container}"). System apps usually have none. Target an installed ` +
        `app, or mark the capability allApps so it loads everywhere instead.`,
    );
  }
  return container;
}

function trampolinePath(): string {
  return join(trampolineDir(), TRAMPOLINE_NAME);
}

const ALL_APPS = "*";

function capabilityKey(bundleId: string | null, name: string): string {
  return `${bundleId ?? ALL_APPS}:${name}`;
}

export async function armTrampoline(udid: string): Promise<void> {
  const dylib = trampolinePath();
  if (!existsSync(dylib)) return;
  try {
    await simctl(["spawn", udid, "launchctl", "setenv", "DYLD_INSERT_LIBRARIES", dylib], 15_000);
  } catch (error) {
    console.error(
      `Could not arm the capability trampoline on ${udid}, so capabilities will not load this ` +
        `session: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function removeTrampolineSync(udid: string): void {
  try {
    execFileSync("xcrun", ["simctl", "spawn", udid, "launchctl", "unsetenv", "DYLD_INSERT_LIBRARIES"], {
      stdio: "ignore",
      timeout: 15_000,
    });
  } catch (error) {
    console.error(
      `Could not disarm the capability trampoline on ${udid}; it is still inserted into every ` +
        `app that simulator starts. Clear it with: xcrun simctl spawn ${udid} launchctl unsetenv ` +
        `DYLD_INSERT_LIBRARIES (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  try { unlinkSync(join(trampolineDir(), CONFIG_NAME)); } catch {}
}

export async function disarmStaleTrampoline(udid: string): Promise<void> {
  const current = await simctl(
    ["spawn", udid, "launchctl", "getenv", "DYLD_INSERT_LIBRARIES"],
    15_000,
  ).catch(() => null);
  if (current === null) {
    console.error(
      `Could not read the current insert on ${udid}, so a stale trampoline from an earlier ` +
        `session cannot be cleaned up. Capabilities may not load until it is.`,
    );
    return;
  }
  if (!current || !current.includes(TRAMPOLINE_NAME) || existsSync(current)) return;
  await removeTrampoline(udid);
}

export async function removeTrampoline(udid: string): Promise<void> {
  await simctl(["spawn", udid, "launchctl", "unsetenv", "DYLD_INSERT_LIBRARIES"], 15_000).catch(
    () => undefined,
  );
  try { unlinkSync(join(trampolineDir(), CONFIG_NAME)); } catch {}
}

export async function launchApp(
  udid: string,
  {
    bundleId,
    launchArgs = [],
    restart = false,
  }: { bundleId: string; launchArgs?: string[]; restart?: boolean },
): Promise<void> {
  await armTrampoline(udid);
  await withLaunchStateLock(udid, async () => {
    const previous = readLaunchState(udid);
    const state: LaunchState = { bundleId, launchArgs, capabilities: previous?.capabilities ?? {} };
    if (restart) {
      await terminateForRelaunch(udid, bundleId);
    }
    const config = renderCapabilityConfig(state);
    await simctl(["launch", udid, bundleId, ...launchArgs]);
    writeLaunchState(udid, state);
    commitCapabilityConfig(config);
  });
}

export async function openUrlInApp(udid: string, bundleId: string, openUrl: string): Promise<void> {
  await preapproveUrlSchemeAsync(udid, bundleId, openUrl);
  await simctl(["openurl", udid, openUrl]);
}

export async function applyDefaultCapabilities(
  udid: string,
  bundleId: string | null,
  overrides: CapabilityOverrides = {},
): Promise<string[]> {
  const definitions = capabilitiesToApply(overrides);
  const resolved: Capability[] = [];
  for (const definition of definitions) {
    const capability = await definition.resolve(udid, bundleId).catch((error: unknown) => {
      console.error(
        `Capability ${definition.name} could not be prepared and will not load: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });
    if (!capability) continue;
    if (bundleId === null && !capability.allApps) continue;
    resolved.push(capability);
  }
  await enableCapabilities(udid, bundleId, resolved);
  const applied = resolved.map((capability) => capability.name);

  for (const name of overrides.enable ?? []) {
    if (applied.includes(name)) continue;
    console.error(
      `Capability ${name} was requested but did not apply on ${udid}` +
        (bundleId === null ? ", because it needs an app and none was given." : "."),
    );
  }
  return applied;
}

export function isCapabilityEnabled(udid: string, bundleId: string, name: string): boolean {
  const state = readLaunchState(udid);
  if (!state) return false;
  return (
    capabilityKey(bundleId, name) in state.capabilities ||
    capabilityKey(null, name) in state.capabilities
  );
}

export function listCapabilities(udid: string, bundleId: string): string[] {
  const state = readLaunchState(udid);
  if (!state) return [];
  return Object.values(state.capabilities)
    .filter((capability) => capability.bundleId === bundleId || capability.allApps)
    .map((capability) => capability.name)
    .sort();
}

export async function enableCapability(
  udid: string,
  bundleId: string,
  capability: Capability,
): Promise<number | null> {
  return await enableCapabilities(udid, bundleId, [capability]);
}

export async function enableCapabilities(
  udid: string,
  bundleId: string | null,
  capabilities: Capability[],
): Promise<number | null> {
  if (capabilities.length === 0) return null;
  const dylib = trampolinePath();
  if (!existsSync(dylib)) {
    throw new Error(
      `Trampoline not built: ${dylib} is missing. Run \`bun run packages/serve-sim/build.ts\` ` +
        `to build the native artifacts, then retry.`,
    );
  }

  const perApp = capabilities.filter((capability) => !capability.allApps);
  const container = bundleId !== null && perApp.length > 0
    ? await containerForBundle(udid, bundleId)
    : "";
  if (perApp.length > 0 && bundleId === null) {
    throw new Error(
      `Capabilities ${perApp.map((c) => c.name).join(", ")} target one app, but no app was given. ` +
        `Pass an application to enable them for, or mark them allApps.`,
    );
  }

  return await withLaunchStateLock(udid, async () => {
    const previous = readLaunchState(udid);
    const added = Object.fromEntries(
      capabilities.map((capability) => {
        const target = capability.allApps ? null : bundleId;
        return [
          capabilityKey(target, capability.name),
          { ...capability, bundleId: target, container: capability.allApps ? "" : container },
        ];
      }),
    );
    const state: LaunchState = {
      ...(previous ?? { launchArgs: [], capabilities: {} }),
      capabilities: { ...(previous?.capabilities ?? {}), ...added },
    };
    const config = renderCapabilityConfig(state);
    await simctl(["spawn", udid, "launchctl", "setenv", "DYLD_INSERT_LIBRARIES", dylib], 15_000);
    writeLaunchState(udid, state);
    commitCapabilityConfig(config);
    return await relaunchTarget(udid, bundleId, state);
  });
}

/** null when the check itself failed, which is not the same as "not running". */
async function isRunning(udid: string, bundleId: string): Promise<boolean | null> {
  const out = await simctl(["spawn", udid, "launchctl", "list"], 15_000).catch(() => null);
  if (out === null) return null;
  return out.includes(`UIKitApplication:${bundleId}`);
}

async function terminateForRelaunch(udid: string, bundleId: string): Promise<void> {
  try {
    await simctl(["terminate", udid, bundleId], TERMINATE_TIMEOUT_MS);
    return;
  } catch {
  }
  const running = await isRunning(udid, bundleId);
  if (running === false) return;
  throw new Error(
    running === null
      ? `Could not stop ${bundleId} on ${udid}, and could not check whether it is still running. ` +
        `Relaunching now would silently do nothing if it is. Check the simulator and retry.`
      : `Could not stop ${bundleId} on ${udid}, so it cannot be relaunched with its capabilities ` +
        `loaded. simctl terminate did not take effect within ${TERMINATE_TIMEOUT_MS / 1000}s. ` +
        `Stop the app yourself and retry.`,
  );
}

async function relaunchTarget(
  udid: string,
  bundleId: string | null,
  state: LaunchState,
): Promise<number | null> {
  const target = bundleId ?? state.bundleId;
  if (!target) return null;
  const args = target === state.bundleId ? state.launchArgs : [];
  await terminateForRelaunch(udid, target);
  const stdout = await simctl(["launch", udid, target, ...args]);
  const match = stdout.match(/:\s*(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

export async function disableCapability(
  udid: string,
  bundleId: string | null,
  name: string,
): Promise<void> {
  await withLaunchStateLock(udid, async () => {
    const previous = readLaunchState(udid);
    const key = capabilityKey(bundleId, name);
    if (!previous || !(key in previous.capabilities)) return;
    const { [key]: _removed, ...rest } = previous.capabilities;
    const state: LaunchState = { ...previous, capabilities: rest };
    const config = renderCapabilityConfig(state);
    writeLaunchState(udid, state);
    commitCapabilityConfig(config);
    await relaunchTarget(udid, bundleId, state);
  });
}

const URL_SCHEME_APPROVAL_DOMAIN = "com.apple.launchservices.schemeapproval";
const URL_SCHEME_APPROVAL_KEY_PREFIX = "com.apple.CoreSimulator.CoreSimulatorBridge-->";

async function preapproveUrlSchemeAsync(
  udid: string,
  bundleId: string,
  openUrl: string,
): Promise<void> {
  const scheme = new URL(openUrl).protocol.slice(0, -1);
  if (scheme === "http" || scheme === "https") return;
  try {
    await simctl([
      "spawn", udid, "defaults", "write",
      URL_SCHEME_APPROVAL_DOMAIN,
      `${URL_SCHEME_APPROVAL_KEY_PREFIX}${scheme}`,
      "-string", bundleId,
    ], 15_000);
  } catch {
    console.error(
      `Could not pre-approve the ${scheme}: URL scheme for ${bundleId}. Opening the URL anyway; ` +
        `the Simulator may ask you to confirm it.`,
    );
  }
}
