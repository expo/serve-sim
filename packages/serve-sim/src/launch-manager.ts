import { execFile, execFileSync } from "child_process";
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
import { promisify } from "util";

import {
  capabilitiesToApply,
  capabilityDefinition,
  type CapabilityContext,
  type CapabilityDefinition,
  type CapabilityOverrides,
  type CapabilityScope,
} from "./capabilities";
import { dirnameOf } from "./runtime";
import { stateDir } from "./state";

const execFileAsync = promisify(execFile);

const TRAMPOLINE_NAME = "libServeSimTrampoline.dylib";
const INSERT = "DYLD_INSERT_LIBRARIES";
const CONFIG_VAR = "SERVE_SIM_CAPABILITIES_CONFIG";
// Same value as MAX_CONFIG_BYTES in Sources/ServeSimTrampoline/serve-sim-trampoline.c.
export const MAX_CONFIG_BYTES = 64 * 1024;
const TERMINATE_TIMEOUT_MS = 15_000;

/** The scope tokens the trampoline matches on. */
const SCOPE_TOKEN: Record<CapabilityScope, string> = { userApps: "user", allApps: "all" };

function isCapabilityScope(value: unknown): value is CapabilityScope {
  return value === "userApps" || value === "allApps";
}

export interface Capability {
  name: string;
  dylib: string;
  env?: Record<string, string>;
  scope: CapabilityScope;
  loadDelayMs?: number;
}

export interface RecordedCapability extends Capability {
  /** The app to relaunch, when one was named. Never narrows what loads. */
  bundleId: string | null;
  /**
   * The process that enabled it, whose exit releases it. A capability enabled
   * for a stream goes when that stream does. `serve-sim camera` exits right
   * away and records null, so its capability survives until an explicit
   * disable.
   */
  ownerPid: number | null;
}

interface LaunchState {
  bundleId?: string;
  launchArgs: string[];
  capabilities: Record<string, RecordedCapability>;
}

function stateFile(udid: string): string {
  return join(stateDir(), `launch-${udid}.json`);
}

function ownerIsGone(ownerPid: number | null): boolean {
  if (ownerPid === null) return false;
  try {
    process.kill(ownerPid, 0);
    return false;
  } catch {
    return true;
  }
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
    capabilities: recordedCapabilities(capabilities),
  };
}

/**
 * Keeps the records that are still usable. A malformed one would reach
 * formatCapabilityConfig and throw there instead of here, and one whose owner
 * died is a leftover nobody will disable.
 */
function recordedCapabilities(value: unknown): Record<string, RecordedCapability> {
  if (typeof value !== "object" || value === null) return {};
  const kept: Record<string, RecordedCapability> = {};
  for (const [key, record] of Object.entries(value)) {
    if (typeof record !== "object" || record === null) continue;
    const { name, dylib, scope, bundleId, ownerPid } = record as Partial<RecordedCapability>;
    if (typeof name !== "string" || typeof dylib !== "string" || !isCapabilityScope(scope)) {
      continue;
    }
    const owner = typeof ownerPid === "number" ? ownerPid : null;
    if (ownerIsGone(owner)) continue;
    kept[key] = {
      ...(record as RecordedCapability),
      bundleId: typeof bundleId === "string" ? bundleId : null,
      ownerPid: owner,
    };
  }
  return kept;
}

/**
 * Drops this process's capability records and reports whether any remain, so a
 * session that armed a device does not disarm it under another one still using it.
 */
export function releaseLaunchState(udid: string, ownerPid: number): boolean {
  const previous = readLaunchState(udid);
  if (!previous) return false;
  const kept = Object.fromEntries(
    Object.entries(previous.capabilities).filter(([, record]) => record.ownerPid !== ownerPid),
  );
  if (Object.keys(kept).length === 0) {
    clearLaunchState(udid);
    return false;
  }
  const state: LaunchState = { ...previous, capabilities: kept };
  writeLaunchState(udid, state);
  commitCapabilityConfig(udid, renderCapabilityConfig(state));
  return true;
}

export function clearLaunchState(udid: string): void {
  try { unlinkSync(stateFile(udid)); } catch {}
}

function writeLaunchState(udid: string, state: LaunchState): void {
  if (!existsSync(stateDir())) mkdirSync(stateDir(), { recursive: true });
  const target = stateFile(udid);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, target);
}

export function trampolineDir(): string {
  return join(dirnameOf(import.meta.url), "..", "dist", "trampoline");
}

function assertNoSeparators(what: string, value: string): void {
  const found = [...value].find((character) => character === "\t" || character === "\n" || character === ";");
  if (found !== undefined) {
    throw new Error(
      `${what} contains ${JSON.stringify(found)}, which separates fields in the capability ` +
        `config the trampoline reads. Remove it, or pass the value through a file instead.`,
    );
  }
}

export function formatCapabilityConfig(
  capabilities: Record<string, RecordedCapability>,
): string {
  const lines = Object.values(capabilities).map((capability) => {
    assertNoSeparators(`Dylib path for ${capability.name}`, capability.dylib);
    const env = Object.entries(capability.env ?? {})
      .map(([key, value]) => {
        assertNoSeparators(`Environment name ${key} for ${capability.name}`, key);
        assertNoSeparators(`Environment value for ${key} in ${capability.name}`, value);
        if (key.includes("=")) {
          throw new Error(
            `Environment name ${JSON.stringify(key)} for ${capability.name} contains "=", which ` +
              `separates the name from the value. Rename it.`,
          );
        }
        return `${key}=${value}`;
      })
      .join(";");
    return [SCOPE_TOKEN[capability.scope], capability.dylib, env, capability.loadDelayMs ?? 0].join(
      "\t",
    );
  });
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export function renderCapabilityConfig(state: LaunchState): string {
  const contents = formatCapabilityConfig(state.capabilities);
  const size = Buffer.byteLength(contents, "utf8");
  if (size >= MAX_CONFIG_BYTES - 1) {
    throw new Error(
      `Capability config is ${size} bytes, over the ${MAX_CONFIG_BYTES} byte limit the trampoline ` +
        `can read. The trampoline would load nothing. Disable capabilities you are not using, or ` +
        `shorten the environment values passed to them.`,
    );
  }
  return contents;
}

export function capabilityConfigPath(udid: string): string {
  return join(stateDir(), `capabilities-${udid}.conf`);
}

function commitCapabilityConfig(udid: string, contents: string): void {
  mkdirSync(stateDir(), { recursive: true });
  const target = capabilityConfigPath(udid);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, contents);
  renameSync(temp, target);
}

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 50;

function lockFile(udid: string): string {
  return join(stateDir(), `launch-${udid}.lock`);
}

function lockHolderIsGone(path: string): boolean {
  let contents: string;
  try {
    contents = readFileSync(path, "utf-8").trim();
  } catch {
    return true;
  }
  // Empty means another process created the file and has not written its pid
  // yet. That is held, not stale.
  if (contents === "") return false;
  const pid = Number(contents);
  if (!Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function withLaunchStateLock<T>(udid: string, fn: () => Promise<T>): Promise<T> {
  if (!existsSync(stateDir())) mkdirSync(stateDir(), { recursive: true });
  const path = lockFile(udid);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | undefined;

  while (fd === undefined) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting to update the launch state for ${udid}. Another serve-sim command ` +
          `is holding ${path}. Wait for it to finish, or remove that file if nothing is running.`,
      );
    }
    try {
      fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid));
    } catch {
      if (lockHolderIsGone(path)) {
        try { unlinkSync(path); } catch {}
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
  const { stdout } = await execFileAsync("xcrun", ["simctl", ...args], {
    encoding: "utf8",
    timeout,
  });
  return stdout.trim();
}

/**
 * `SIMCTL_CHILD_*` variables reach the app simctl launches. The insert has to
 * carry the capability dylib itself, so a swizzle is in place before the app's
 * own code runs, and the trampoline, because simctl's value replaces the
 * device-wide one for this process and would otherwise drop every other
 * capability.
 */
export function childLaunchEnv(
  dylib: string,
  capabilityEnv: Record<string, string>,
): Record<string, string> {
  return {
    SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: [dylib, trampolinePath()].join(":"),
    ...Object.fromEntries(
      Object.entries(capabilityEnv).map(([key, value]) => [`SIMCTL_CHILD_${key}`, value]),
    ),
  };
}

const armedHere = new Set<string>();

export function devicesArmedHere(): string[] {
  return [...armedHere];
}

// DYLD_INSERT_LIBRARIES is a colon-separated list. Another tool may already
// have one set, so add and remove only our own entry.
function withoutOurs(current: string): string[] {
  return current
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && !entry.endsWith(TRAMPOLINE_NAME));
}

async function readInsert(udid: string): Promise<string> {
  return (await simctl(["spawn", udid, "launchctl", "getenv", INSERT], 15_000).catch(() => "")).trim();
}

async function armInsert(udid: string, dylib: string): Promise<void> {
  const next = [...withoutOurs(await readInsert(udid)), dylib].join(":");
  await simctl(["spawn", udid, "launchctl", "setenv", INSERT, next], 15_000);
  await simctl(["spawn", udid, "launchctl", "setenv", CONFIG_VAR, capabilityConfigPath(udid)], 15_000);
  armedHere.add(udid);
}

export function trampolinePath(): string {
  return join(trampolineDir(), TRAMPOLINE_NAME);
}

export async function armTrampoline(udid: string): Promise<void> {
  const dylib = trampolinePath();
  if (!existsSync(dylib)) return;
  try {
    await armInsert(udid, dylib);
  } catch (error) {
    console.error(
      `Could not arm the capability trampoline on ${udid}, so capabilities will not load this ` +
        `session: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function removeTrampolineSync(udid: string): void {
  try {
    execFileSync("xcrun", ["simctl", "spawn", udid, "launchctl", "unsetenv", CONFIG_VAR], {
      stdio: "ignore",
      timeout: 15_000,
    });
    const current = execFileSync(
      "xcrun",
      ["simctl", "spawn", udid, "launchctl", "getenv", INSERT],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 },
    ).trim();
    const rest = withoutOurs(current).join(":");
    const clear = rest === ""
      ? ["simctl", "spawn", udid, "launchctl", "unsetenv", INSERT]
      : ["simctl", "spawn", udid, "launchctl", "setenv", INSERT, rest];
    execFileSync("xcrun", clear, { stdio: "ignore", timeout: 15_000 });
  } catch (error) {
    console.error(
      `Could not disarm the capability trampoline on ${udid}; it is still inserted into every ` +
        `app that simulator starts. Clear it with: xcrun simctl spawn ${udid} launchctl unsetenv ` +
        `DYLD_INSERT_LIBRARIES (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  try { unlinkSync(capabilityConfigPath(udid)); } catch {}
  armedHere.delete(udid);
}

export async function disarmStaleTrampoline(udid: string): Promise<void> {
  const current = await simctl(["spawn", udid, "launchctl", "getenv", INSERT], 15_000).catch(() => null);
  if (current === null) {
    console.error(
      `Could not read the current insert on ${udid}, so a stale trampoline from an earlier ` +
        `session cannot be cleaned up. Capabilities may not load until it is.`,
    );
    return;
  }
  const ours = current
    .split(":")
    .map((entry) => entry.trim())
    .find((entry) => entry.endsWith(TRAMPOLINE_NAME));
  if (!ours || existsSync(ours)) return;
  await removeTrampoline(udid);
}

export async function removeTrampoline(udid: string): Promise<void> {
  await simctl(["spawn", udid, "launchctl", "unsetenv", CONFIG_VAR], 15_000).catch(
    () => undefined,
  );
  const rest = withoutOurs(await readInsert(udid)).join(":");
  const clear = rest === ""
    ? ["spawn", udid, "launchctl", "unsetenv", INSERT]
    : ["spawn", udid, "launchctl", "setenv", INSERT, rest];
  await simctl(clear, 15_000).catch(() => undefined);
  try { unlinkSync(capabilityConfigPath(udid)); } catch {}
  armedHere.delete(udid);
}

export async function launchApp(
  udid: string,
  {
    bundleId,
    launchArgs = [],
    restart = false,
  }: { bundleId: string; launchArgs?: string[]; restart?: boolean },
): Promise<void> {
  await withLaunchStateLock(udid, async () => {
    const previous = readLaunchState(udid);
    const state: LaunchState = { bundleId, launchArgs, capabilities: previous?.capabilities ?? {} };
    const config = renderCapabilityConfig(state);
    // The trampoline reads its config once, as the process starts, so both the
    // insert and the config have to be in place before the launch they apply to.
    if (Object.keys(state.capabilities).length > 0) await armTrampoline(udid);
    writeLaunchState(udid, state);
    commitCapabilityConfig(udid, config);
    if (restart) {
      await terminateForRelaunch(udid, bundleId);
    }
    await simctl(["launch", udid, bundleId, ...launchArgs]);
  });
}

export async function openUrlInApp(udid: string, bundleId: string, openUrl: string): Promise<void> {
  await preapproveUrlSchemeAsync(udid, bundleId, openUrl);
  await simctl(["openurl", udid, openUrl]);
}

/**
 * Runs a definition's own state change and stamps the fields the manager owns,
 * so a definition cannot resolve to a different name or scope than it declared.
 */
async function prepare(
  definition: CapabilityDefinition,
  context: CapabilityContext,
): Promise<Capability | null> {
  const prepared = await definition.setEnabled(context).catch((error: unknown) => {
    console.error(
      `Capability ${definition.name} could not be prepared and will not load: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  });
  if (!prepared) return null;
  return {
    name: definition.name,
    dylib: prepared.dylib,
    env: prepared.env,
    scope: definition.scope,
    loadDelayMs: definition.loadDelayMs,
  };
}

/** Turns a registered capability on or off, including its host-side work. */
export async function setCapabilityEnabled(
  udid: string,
  name: string,
  {
    bundleId = null,
    options = {},
    enabled,
    relaunch = true,
    ownerPid = process.pid,
  }: {
    bundleId?: string | null;
    options?: Record<string, string>;
    enabled: boolean;
  } & EnableOptions,
): Promise<void> {
  const definition = capabilityDefinition(name);
  const context: CapabilityContext = { udid, bundleId, options, enabled };

  if (!enabled) {
    await definition.setEnabled(context);
    await disableCapability(udid, bundleId, name, { relaunch: false });
    return;
  }

  const capability = await prepare(definition, context);
  if (!capability) {
    throw new Error(
      `Capability ${name} declined to start on ${udid}. It reported nothing to load, so there ` +
        `is nothing to enable. Check the message above for why.`,
    );
  }
  await enableCapabilities(udid, bundleId, [capability], { relaunch, ownerPid });
}

export async function applyDefaultCapabilities(
  udid: string,
  bundleId: string | null,
  overrides: CapabilityOverrides = {},
): Promise<string[]> {
  const definitions = capabilitiesToApply(overrides);
  const resolved: Capability[] = [];
  for (const definition of definitions) {
    const capability = await prepare(definition, { udid, bundleId, options: {}, enabled: true });
    if (!capability) continue;
    resolved.push(capability);
  }
  await enableCapabilities(udid, bundleId, resolved);
  const applied = resolved.map((capability) => capability.name);

  for (const name of overrides.enable ?? []) {
    if (applied.includes(name)) continue;
    console.error(
      `Capability ${name} was requested but did not apply on ${udid}.`,
    );
  }
  return applied;
}

export function isCapabilityEnabled(udid: string, name: string): boolean {
  const state = readLaunchState(udid);
  return state !== null && name in state.capabilities;
}

export function listCapabilities(udid: string): string[] {
  const state = readLaunchState(udid);
  if (!state) return [];
  return Object.values(state.capabilities)
    .map((capability) => capability.name)
    .sort();
}

/**
 * `relaunch: false` records the capability for a caller that launches it itself.
 * `ownerPid: null` records one that outlives the command enabling it.
 */
export type EnableOptions = { relaunch?: boolean; ownerPid?: number | null };

export async function enableCapabilities(
  udid: string,
  bundleId: string | null,
  capabilities: Capability[],
  { relaunch = true, ownerPid = process.pid }: EnableOptions = {},
): Promise<void> {
  if (capabilities.length === 0) return;
  const dylib = trampolinePath();
  if (!existsSync(dylib)) {
    throw new Error(
      `Trampoline not built: ${dylib} is missing. Run \`bun run packages/serve-sim/build.ts\` ` +
        `to build the native artifacts, then retry.`,
    );
  }

  return await withLaunchStateLock(udid, async () => {
    const previous = readLaunchState(udid);
    const added = Object.fromEntries(
      capabilities.map((capability) => [
        capability.name,
        { ...capability, bundleId, ownerPid },
      ]),
    );
    const state: LaunchState = {
      ...(previous ?? { launchArgs: [], capabilities: {} }),
      capabilities: { ...(previous?.capabilities ?? {}), ...added },
    };
    const config = renderCapabilityConfig(state);
    await armInsert(udid, dylib);
    writeLaunchState(udid, state);
    commitCapabilityConfig(udid, config);
    if (relaunch) await relaunchTarget(udid, bundleId, state);
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
        `Relaunching now would do nothing if it is. Check the simulator and retry.`
      : `Could not stop ${bundleId} on ${udid}, so it cannot be relaunched with its capabilities ` +
        `loaded. simctl terminate did not take effect within ${TERMINATE_TIMEOUT_MS / 1000}s. ` +
        `Stop the app yourself and retry.`,
  );
}

async function relaunchTarget(
  udid: string,
  bundleId: string | null,
  state: LaunchState,
): Promise<void> {
  const target = bundleId ?? state.bundleId;
  if (!target) return;
  const args = target === state.bundleId ? state.launchArgs : [];
  await terminateForRelaunch(udid, target);
  await simctl(["launch", udid, target, ...args]);
}

export async function disableCapability(
  udid: string,
  bundleId: string | null,
  name: string,
  { relaunch = true }: EnableOptions = {},
): Promise<void> {
  await withLaunchStateLock(udid, async () => {
    const previous = readLaunchState(udid);
    if (!previous) return;
    if (!(name in previous.capabilities)) return;
    const rest = Object.fromEntries(
      Object.entries(previous.capabilities).filter(([key]) => key !== name),
    );
    const state: LaunchState = { ...previous, capabilities: rest };
    const config = renderCapabilityConfig(state);
    writeLaunchState(udid, state);
    commitCapabilityConfig(udid, config);
    if (relaunch) await relaunchTarget(udid, bundleId, state);
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
