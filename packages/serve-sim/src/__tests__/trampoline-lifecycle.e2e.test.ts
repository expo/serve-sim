import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";

import { e2eDevice, readInsert, requireE2E } from "./e2e-preconditions";
import {
  armTrampoline,
  capabilityConfigPath,
  disarmStaleTrampoline,
  removeTrampoline,
  removeTrampolineSync,
  trampolineDir,
} from "../launch-manager";

// The insert is device-wide state, so every test here asserts it is gone again.

const TRAMPOLINE = join(trampolineDir(), "libServeSimTrampoline.dylib");

const udid = e2eDevice();
const ready = udid !== null && existsSync(TRAMPOLINE);

requireE2E("trampoline lifecycle", ready);

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

// removeTrampolineSync only drops our own dylib, which is the point of it, so it
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
  removeTrampolineSync(udid!);
}, 60_000);

afterEach(() => {
  if (!ready) return;
  removeTrampolineSync(udid!);
  restoreInsert();
});

afterAll(() => {
  if (!ready) return;
  removeTrampolineSync(udid!);
  restoreInsert();
});

describe.skipIf(!ready)("trampoline lifecycle", () => {
  test("arming inserts the trampoline device-wide", async () => {
    await armTrampoline(udid!);
    expect(readInsert(udid!)).toBe(TRAMPOLINE);
  }, 60_000);

  test("removing it leaves nothing inserted and no config behind", async () => {
    await armTrampoline(udid!);
    writeFileSync(capabilityConfigPath(udid!), "\t/opt/probe.dylib\t\n");

    await removeTrampoline(udid!);

    expect(readInsert(udid!)).toBe("");
    expect(existsSync(capabilityConfigPath(udid!))).toBe(false);
  }, 60_000);

  test("an exit handler can clear it without awaiting", async () => {
    await armTrampoline(udid!);
    writeFileSync(capabilityConfigPath(udid!), "\t/opt/probe.dylib\t\n");

    removeTrampolineSync(udid!);

    expect(readInsert(udid!)).toBe("");
    expect(existsSync(capabilityConfigPath(udid!))).toBe(false);
  }, 60_000);

  test("a trampoline left by a session whose build is gone is cleared", async () => {
    setInsert(join(trampolineDir(), "gone", "libServeSimTrampoline.dylib"));

    await disarmStaleTrampoline(udid!);

    expect(readInsert(udid!)).toBe("");
  }, 60_000);

  test("a trampoline that still exists is left alone", async () => {
    await armTrampoline(udid!);

    await disarmStaleTrampoline(udid!);

    expect(readInsert(udid!)).toBe(TRAMPOLINE);
  }, 60_000);

  test("an insert that is not ours is left alone", async () => {
    setInsert("/usr/lib/libSomethingElse.dylib");

    await disarmStaleTrampoline(udid!);

    expect(readInsert(udid!)).toBe("/usr/lib/libSomethingElse.dylib");
  }, 60_000);
});
