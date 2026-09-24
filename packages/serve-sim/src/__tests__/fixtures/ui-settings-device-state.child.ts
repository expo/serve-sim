import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const stateDirectory = mkdtempSync(join(tmpdir(), "serve-sim-ui-state-"));
process.env.SERVE_SIM_STATE_DIR = stateDirectory;

const bootRequests: ExecCallback[] = [];
const hardwareKeyboardUpdates: boolean[] = [];
let hardwareKeyboardResult = true;
const childProcess = await import("child_process");

mock.module("child_process", () => ({
  ...childProcess,
  execFile(
    _file: string,
    _args: string[],
    _options: unknown,
    callback: ExecCallback,
  ) {
    bootRequests.push(callback);
    return {};
  },
}));

mock.module("../../native", () => ({
  setHardwareKeyboard: async (_udid: string, enabled: boolean) => {
    hardwareKeyboardUpdates.push(enabled);
    return hardwareKeyboardResult;
  },
}));

const { getUiOption, refreshDeviceOptionState, setUiOption, setUiOptionIfRevision } = await import("../../ui-settings");

async function waitForBootRequests(count: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (bootRequests.length < count) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a boot-session lookup");
    await Bun.sleep(1);
  }
}

function resolveBootRequest(index: number, bootSession: string): void {
  const request = bootRequests.splice(index, 1)[0];
  if (!request) throw new Error(`Missing boot-session lookup at index ${index}`);
  request(null, `${bootSession}\n`, "");
}

async function setHardwareKeyboard(udid: string, value: "on" | "off", bootSession: string): Promise<string> {
  const setting = setUiOption(udid, "hardware-keyboard", value);
  await waitForBootRequests(1);
  resolveBootRequest(0, bootSession);
  return (await setting)!;
}

beforeEach(() => {
  bootRequests.length = 0;
  hardwareKeyboardUpdates.length = 0;
  hardwareKeyboardResult = true;
});

afterAll(() => {
  rmSync(stateDirectory, { recursive: true, force: true });
});

describe("device-backed UI option state", () => {
  test("preserves a CLI setting when preview starts in the same boot", async () => {
    const udid = "SAME-BOOT";
    await setHardwareKeyboard(udid, "off", "100");
    const refresh = refreshDeviceOptionState(udid);
    await waitForBootRequests(1);
    resolveBootRequest(0, "100");
    await refresh;
    expect(await getUiOption(udid, "hardware-keyboard")).toBe("off");
    expect(hardwareKeyboardUpdates).toEqual([false]);
  });

  test("ignores a setting from a previous simulator boot", async () => {
    const udid = "NEW-BOOT";
    await setHardwareKeyboard(udid, "off", "100");
    const refresh = refreshDeviceOptionState(udid);
    await waitForBootRequests(1);
    resolveBootRequest(0, "200");
    await refresh;
    expect(await getUiOption(udid, "hardware-keyboard")).toBe("on");
  });

  test("keeps a CLI setting written while preview refreshes its boot", async () => {
    const udid = "RACING-BOOT";
    await setHardwareKeyboard(udid, "off", "100");

    const refresh = refreshDeviceOptionState(udid);
    await waitForBootRequests(1);
    const setting = setUiOption(udid, "hardware-keyboard", "off");
    await waitForBootRequests(2);
    resolveBootRequest(1, "200");
    await setting;
    resolveBootRequest(0, "200");
    await refresh;

    expect(await getUiOption(udid, "hardware-keyboard")).toBe("off");
    expect(hardwareKeyboardUpdates).toEqual([false, false]);
  });

  test("does not save a hardware-keyboard change rejected by CoreSimulator", async () => {
    const udid = "REJECTED-CHANGE";
    await setHardwareKeyboard(udid, "off", "100");
    hardwareKeyboardResult = false;

    const setting = setUiOption(udid, "hardware-keyboard", "on");
    await waitForBootRequests(1);
    resolveBootRequest(0, "100");
    await expect(setting).rejects.toThrow("CoreSimulator rejected");

    expect(await getUiOption(udid, "hardware-keyboard")).toBe("off");
    expect(hardwareKeyboardUpdates).toEqual([false, true]);
  });

  test("restores only the device setting revision owned by the session", async () => {
    const udid = "CONDITIONAL-RESTORE";
    const sessionRevision = await setHardwareKeyboard(udid, "off", "100");
    const cliRevision = await setHardwareKeyboard(udid, "off", "100");

    const skipped = setUiOptionIfRevision(udid, "hardware-keyboard", "on", sessionRevision);
    await waitForBootRequests(1);
    resolveBootRequest(0, "100");
    expect(await skipped).toBeNull();
    expect(await getUiOption(udid, "hardware-keyboard")).toBe("off");

    const restoring = setUiOptionIfRevision(udid, "hardware-keyboard", "on", cliRevision);
    await waitForBootRequests(1);
    resolveBootRequest(0, "100");
    expect(await restoring).toEqual(expect.any(String));
    expect(await getUiOption(udid, "hardware-keyboard")).toBe("on");
  });
});
