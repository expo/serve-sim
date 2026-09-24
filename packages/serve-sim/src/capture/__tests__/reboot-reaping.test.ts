import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { UDID, installShims, useTempStateDir } from "../../__tests__/helpers";
import { readServeSimStates } from "../../middleware";
import { inProcessServeSimState } from "../../state";
import { captureRuntime, createCaptureRuntime } from "../runtime";
import { capabilityHarness } from "./capability-harness";
import { rebootWithCapture } from "../reboot";

const OTHER_UDID = "5C1E0B7A-3F2D-4E8A-9B61-7D0C2A4F9E13";

let shims: ReturnType<typeof installShims>;
let stateDir: ReturnType<typeof useTempStateDir>;

beforeAll(() => {
  // No device is booted, so every state this process owns looks shut down to a poll.
  shims = installShims({ xcrun: `#!/bin/sh\necho '{"devices":{}}'\n` });
  stateDir = useTempStateDir();
});

afterAll(() => {
  stateDir.restore();
  shims.restore();
});

function writeOwnState(udid: string): string {
  const file = join(stateDir.dir, `server-${udid}.json`);
  writeFileSync(file, JSON.stringify(inProcessServeSimState(udid, 3100)));
  return file;
}

test("keeps a device's state while its capture reboot has it shut down", async () => {
  const file = writeOwnState(UDID);
  const runtime = createCaptureRuntime({
    configure: capabilityHarness({ publish: async () => {}, remove: async () => {} }),
  });
  let release = () => {};
  const shutDown = new Promise<void>((resolve) => (release = resolve));
  const reboot = rebootWithCapture(UDID, false, {
    runtime,
    shutdown: () => shutDown,
    boot: async () => {},
    rearm: async () => {},
  });

  expect((await readServeSimStates()).map((state) => state.device)).toContain(UDID);

  release();
  await reboot;
  // The next poll can still reuse the boot-state snapshot taken while the device was down.
  expect((await readServeSimStates()).map((state) => state.device)).toContain(UDID);
  expect(existsSync(file)).toBe(true);
});

test("stops capture for a device that was shut down outside the preview", async () => {
  const file = writeOwnState(OTHER_UDID);
  const disabled: string[] = [];
  const disableForDevice = captureRuntime.disableForDevice;
  captureRuntime.disableForDevice = async (udid) => void disabled.push(udid);
  try {
    await readServeSimStates();
    await Bun.sleep(0);
    expect(disabled).toEqual([OTHER_UDID]);
    expect(existsSync(file)).toBe(false);
  } finally {
    captureRuntime.disableForDevice = disableForDevice;
  }
});
