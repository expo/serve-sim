import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { clearServeSimState, inProcessServeSimState, stateFileForDevice, writeServeSimState } from "../state";


const CLI_PATH = join(import.meta.dir, "../../src/index.ts");

function firstBootedIosSim(): string | null {
  try {
    const out = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
    const data = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const [runtime, devices] of Object.entries(data.devices)) {
      if (!runtime.includes("iOS")) continue;
      for (const device of devices) {
        if (device.state === "Booted") return device.udid;
      }
    }
  } catch {}
  return null;
}

function statePid(file: string): number {
  return (JSON.parse(readFileSync(file, "utf-8")) as { pid: number }).pid;
}

describe("clearServeSimState", () => {
  const device = `OWNERSHIP-${process.pid}`;
  const file = stateFileForDevice(device);

  afterEach(() => {
    try { unlinkSync(file); } catch {}
  });

  test("drops the record the caller owns", () => {
    writeServeSimState(inProcessServeSimState(device, 3200));

    clearServeSimState(device, process.pid);

    expect(existsSync(file)).toBe(false);
  });

  test("keeps a successor's record when a late predecessor exits", () => {
    writeServeSimState(inProcessServeSimState(device, 3200));

    clearServeSimState(device, process.pid + 1);

    expect(existsSync(file)).toBe(true);
  });

  test("is a no-op when the device has no record", () => {
    expect(() => clearServeSimState(device, process.pid)).not.toThrow();
    expect(existsSync(file)).toBe(false);
  });
});

const bootedUdid = firstBootedIosSim();
const describeWithSim = bootedUdid ? describe : describe.skip;

describeWithSim(`serve-sim state ownership e2e (booted sim ${bootedUdid ?? "<skipped>"})`, () => {
  const stateFile = stateFileForDevice(bootedUdid ?? "");
  let predecessorPid = 0;

  function killAll(): void {
    try { execSync(`bun run ${CLI_PATH} --kill`, { stdio: "pipe" }); } catch {}
  }

  function startServer(): number {
    const port = 41_000 + Math.floor(Math.random() * 20_000);
    const detach = spawnSync("bun", ["run", CLI_PATH, "--detach", "-p", String(port), bootedUdid!], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 45_000,
    });
    if (detach.status !== 0 || !detach.stdout) {
      throw new Error(
        `serve-sim --detach failed (exit=${detach.status} signal=${detach.signal})\nstdout: ${detach.stdout ?? "<none>"}`,
      );
    }
    return statePid(stateFile);
  }

  async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { return; }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeAll(killAll, 30_000);

  afterAll(() => {
    if (predecessorPid > 0) {
      try { process.kill(predecessorPid, "SIGCONT"); } catch {}
      try { process.kill(predecessorPid, "SIGKILL"); } catch {}
    }
    killAll();
  }, 30_000);

  test("a late-exiting server does not unlink its replacement's record", async () => {
    predecessorPid = startServer();

    process.kill(predecessorPid, "SIGSTOP");
    try { execSync(`bun run ${CLI_PATH} --kill ${bootedUdid}`, { stdio: "pipe" }); } catch {}

    const successorPid = startServer();
    expect(successorPid).not.toBe(predecessorPid);

    process.kill(predecessorPid, "SIGCONT");
    await waitForExit(predecessorPid, 15_000);
    expect(() => process.kill(predecessorPid, 0)).toThrow();

    expect(existsSync(stateFile)).toBe(true);
    expect(statePid(stateFile)).toBe(successorPid);
  }, 120_000);
});
