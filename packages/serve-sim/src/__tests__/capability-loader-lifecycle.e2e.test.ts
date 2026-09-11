import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";

import { e2eDevice, readInsert, requireE2E } from "./e2e-preconditions";
import {
  armCapabilityLoader,
  capabilityConfigPath,
  disarmStaleCapabilityLoader,
  removeCapabilityLoader,
  removeCapabilityLoaderSync,
  capabilityLoaderDir,
} from "../launch-manager";

// The insert is device-wide state, so every test here asserts it is gone again.

const CAPABILITY_LOADER = join(capabilityLoaderDir(), "libServeSimCapabilityLoader.dylib");

const udid = e2eDevice();
const ready = udid !== null && existsSync(CAPABILITY_LOADER);

requireE2E("capability loader lifecycle", ready);

function setInsert(value: string): void {
  execFileSync(
    "xcrun",
    ["simctl", "spawn", udid!, "launchctl", "setenv", "DYLD_INSERT_LIBRARIES", value],
    { stdio: "ignore", timeout: 30_000 },
  );
}

function unsetInsert(): void {
  execFileSync(
    "xcrun",
    ["simctl", "spawn", udid!, "launchctl", "unsetenv", "DYLD_INSERT_LIBRARIES"],
    { stdio: "ignore", timeout: 30_000 },
  );
}

// removeCapabilityLoaderSync only drops our own dylib, which is the point of it, so it
// cannot undo an insert these tests set to something else. Put the device back
// the way it was found instead; other sessions share it.
let initialInsert: string | null = null;

function restoreInsert(): void {
  if (initialInsert === null || initialInsert === "") unsetInsert();
  else setInsert(initialInsert);
}

beforeAll(() => {
  if (!ready) return;
  initialInsert = readInsert(udid!);
  removeCapabilityLoaderSync(udid!);
}, 60_000);

afterEach(() => {
  if (!ready) return;
  removeCapabilityLoaderSync(udid!);
  restoreInsert();
});

afterAll(() => {
  if (!ready) return;
  removeCapabilityLoaderSync(udid!);
  restoreInsert();
});

describe.skipIf(!ready)("capability loader lifecycle", () => {
  test("arming inserts the capability loader device-wide", async () => {
    await armCapabilityLoader(udid!);
    expect(readInsert(udid!)).toBe(CAPABILITY_LOADER);
  }, 60_000);

  test("removing it leaves nothing inserted and no config behind", async () => {
    await armCapabilityLoader(udid!);
    writeFileSync(capabilityConfigPath(udid!), "\t/opt/probe.dylib\t\n");

    await removeCapabilityLoader(udid!);

    expect(readInsert(udid!)).toBe("");
    expect(existsSync(capabilityConfigPath(udid!))).toBe(false);
  }, 60_000);

  test("an exit handler can clear it without awaiting", async () => {
    await armCapabilityLoader(udid!);
    writeFileSync(capabilityConfigPath(udid!), "\t/opt/probe.dylib\t\n");

    removeCapabilityLoaderSync(udid!);

    expect(readInsert(udid!)).toBe("");
    expect(existsSync(capabilityConfigPath(udid!))).toBe(false);
  }, 60_000);

  test("a capability loader left by a session whose build is gone is cleared", async () => {
    setInsert(join(capabilityLoaderDir(), "gone", "libServeSimCapabilityLoader.dylib"));

    await disarmStaleCapabilityLoader(udid!);

    expect(readInsert(udid!)).toBe("");
  }, 60_000);

  test("a capability loader that still exists is left alone", async () => {
    await armCapabilityLoader(udid!);

    await disarmStaleCapabilityLoader(udid!);

    expect(readInsert(udid!)).toBe(CAPABILITY_LOADER);
  }, 60_000);

  test("an insert that is not ours is left alone", async () => {
    setInsert("/usr/lib/libSomethingElse.dylib");

    await disarmStaleCapabilityLoader(udid!);

    expect(readInsert(udid!)).toBe("/usr/lib/libSomethingElse.dylib");
  }, 60_000);
});
