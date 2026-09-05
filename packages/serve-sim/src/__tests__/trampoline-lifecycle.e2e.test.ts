import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";

import { e2eDevice, requireE2E } from "./e2e-preconditions";
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

function insert(): string {
  try {
    return execFileSync(
      "xcrun",
      ["simctl", "spawn", udid!, "launchctl", "getenv", "DYLD_INSERT_LIBRARIES"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
    ).trim();
  } catch {
    return "";
  }
}

function setInsert(value: string): void {
  execFileSync(
    "xcrun",
    ["simctl", "spawn", udid!, "launchctl", "setenv", "DYLD_INSERT_LIBRARIES", value],
    { stdio: "ignore", timeout: 30_000 },
  );
}

beforeAll(() => {
  if (!ready) return;
  removeTrampolineSync(udid!);
}, 60_000);

afterEach(() => {
  if (!ready) return;
  removeTrampolineSync(udid!);
});

afterAll(() => {
  if (!ready) return;
  removeTrampolineSync(udid!);
});

describe.skipIf(!ready)("trampoline lifecycle", () => {
  test("arming inserts the trampoline device-wide", async () => {
    await armTrampoline(udid!);
    expect(insert()).toBe(TRAMPOLINE);
  }, 60_000);

  test("removing it leaves nothing inserted and no config behind", async () => {
    await armTrampoline(udid!);
    writeFileSync(capabilityConfigPath(udid!), "\t/opt/probe.dylib\t\n");

    await removeTrampoline(udid!);

    expect(insert()).toBe("");
    expect(existsSync(capabilityConfigPath(udid!))).toBe(false);
  }, 60_000);

  test("the synchronous teardown clears it too, for exit handlers", async () => {
    await armTrampoline(udid!);
    writeFileSync(capabilityConfigPath(udid!), "\t/opt/probe.dylib\t\n");

    removeTrampolineSync(udid!);

    expect(insert()).toBe("");
    expect(existsSync(capabilityConfigPath(udid!))).toBe(false);
  }, 60_000);

  test("a trampoline left by a session whose build is gone is cleared", async () => {
    setInsert(join(trampolineDir(), "gone", "libServeSimTrampoline.dylib"));

    await disarmStaleTrampoline(udid!);

    expect(insert()).toBe("");
  }, 60_000);

  test("a trampoline that still exists is left alone", async () => {
    await armTrampoline(udid!);

    await disarmStaleTrampoline(udid!);

    expect(insert()).toBe(TRAMPOLINE);
  }, 60_000);

  test("an insert that is not ours is left alone", async () => {
    setInsert("/usr/lib/libSomethingElse.dylib");

    await disarmStaleTrampoline(udid!);

    expect(insert()).toBe("/usr/lib/libSomethingElse.dylib");
  }, 60_000);
});
