import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { withLaunchStateLock, withLaunchStateLockSync } from "../launch-state-lock";
import { dirnameOf } from "../runtime";
import { simctl, simctlSync } from "../simctl";

const __dirname = dirnameOf(import.meta.url);
const DYLIB_NAME = "libSimNetProxy.dylib";
const DYLD_VAR = "DYLD_INSERT_LIBRARIES";
const PORT_FILE_VAR = "SIMNET_PROXY_PORT_FILE";

export async function trustCaInSimulator(udid: string, caPem: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-ca-"));
  const certPath = join(dir, "capture-root.crt");
  try {
    writeFileSync(certPath, caPem);
    await simctl(["keychain", udid, "add-root-cert", certPath]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function proxyDylibCandidates(): string[] {
  return [
    join(__dirname, "simnet", DYLIB_NAME),
    join(__dirname, "..", "dist", "simnet", DYLIB_NAME),
    join(__dirname, "..", "..", "dist", "simnet", DYLIB_NAME),
  ];
}

function locateProxyDylib(): string | null {
  return proxyDylibCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

function injectedLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("[simnetproxy]"));
}

function withoutProxyEntry(current: string): string[] {
  return injectedLines(current)
    .flatMap((line) => line.split(":"))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && basename(entry) !== DYLIB_NAME);
}

export interface InjectionDeps {
  dylib?: () => string | null;
  run?: (args: string[]) => Promise<string>;
}

function launchctl(udid: string, ...args: string[]): string[] {
  return ["spawn", udid, "launchctl", ...args];
}

interface EnvUpdate {
  name: typeof DYLD_VAR | typeof PORT_FILE_VAR;
  args: string[];
}

function clearInjectionUpdates(udid: string, current: string): EnvUpdate[] {
  const remaining = withoutProxyEntry(current);
  const dylibArgs =
    remaining.length === 0
      ? launchctl(udid, "unsetenv", DYLD_VAR)
      : launchctl(udid, "setenv", DYLD_VAR, remaining.join(":"));

  return [
    { name: DYLD_VAR, args: dylibArgs },
    { name: PORT_FILE_VAR, args: launchctl(udid, "unsetenv", PORT_FILE_VAR) },
  ];
}

export async function injectAtBoot(
  udid: string,
  portFile: string,
  deps: InjectionDeps = {},
): Promise<void> {
  const run = deps.run ?? simctl;
  const library = (deps.dylib ?? locateProxyDylib)();
  if (!library) {
    throw new Error(
      `Could not find ${DYLIB_NAME}, the library that points an app at the capture proxy. This build of ` +
        "serve-sim is missing dist/simnet; reinstall from a recent release.",
    );
  }

  await withLaunchStateLock(udid, async () => {
    const current = await run(launchctl(udid, "getenv", DYLD_VAR));
    const next = [...withoutProxyEntry(current), library].join(":");
    await run(launchctl(udid, "setenv", DYLD_VAR, next));
    await run(launchctl(udid, "setenv", PORT_FILE_VAR, portFile));
  });
}

type ReadEnv = (args: string[]) => Promise<string>;

async function readInjectedVar(udid: string, name: string, read: ReadEnv): Promise<string[]> {
  return injectedLines(await read(launchctl(udid, "getenv", name)));
}

function hasProxyEntry(values: string[]): boolean {
  return values
    .flatMap((line) => line.split(":"))
    .some((entry) => basename(entry.trim()) === DYLIB_NAME);
}

export async function isDeviceInjected(
  udid: string,
  portFile: string,
  deps: { read?: ReadEnv } = {},
): Promise<boolean> {
  const read = deps.read ?? simctl;
  const ports = await readInjectedVar(udid, PORT_FILE_VAR, read);
  if (!ports.includes(portFile)) return false;
  return hasProxyEntry(await readInjectedVar(udid, DYLD_VAR, read));
}

function isDeviceUnavailable(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /Unable to lookup device|Invalid device|current state: Shutdown|device is not booted/i.test(
    text,
  );
}

export async function clearBootInjection(udid: string, deps: InjectionDeps = {}): Promise<void> {
  const run = deps.run ?? simctl;
  let clearing: EnvUpdate["name"] = DYLD_VAR;
  try {
    await withLaunchStateLock(udid, async () => {
      const current = await run(launchctl(udid, "getenv", DYLD_VAR));
      for (const update of clearInjectionUpdates(udid, current)) {
        clearing = update.name;
        await run(update.args);
      }
    });
  } catch (error) {
    if (isDeviceUnavailable(error)) return;
    throw new Error(
      `Could not clear ${clearing} on ${udid}, so apps launched on it may still load the capture library. ` +
        `Reboot the device to clear it. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export function clearBootInjectionSync(
  udid: string,
  deps: { run?: (args: string[]) => string } = {},
): void {
  const run = deps.run ?? simctlSync;
  try {
    withLaunchStateLockSync(udid, () => {
      const current = run(launchctl(udid, "getenv", DYLD_VAR));
      for (const update of clearInjectionUpdates(udid, current)) {
        run(update.args);
      }
    });
  } catch (error) {
    if (isDeviceUnavailable(error)) return;
    throw error;
  }
}

export async function bootInjectionCleared(
  udid: string,
  deps: { read?: ReadEnv } = {},
): Promise<boolean> {
  const read = deps.read ?? simctl;
  try {
    const dylibs = await readInjectedVar(udid, DYLD_VAR, read);
    if (hasProxyEntry(dylibs)) return false;
    return (await readInjectedVar(udid, PORT_FILE_VAR, read)).length === 0;
  } catch (error) {
    return isDeviceUnavailable(error);
  }
}
