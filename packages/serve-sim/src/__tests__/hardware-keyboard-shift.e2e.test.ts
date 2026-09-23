import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import WebSocket from "ws";
import { parseDetachState } from "./detach-state";
import { freePortAsync } from "./helpers";
import { textToKeyEvents } from "../text-to-keys";
import type { ServeSimDeviceState } from "../state";

const CLI_PATH = join(import.meta.dir, "../../dist/serve-sim.js");
const FIXTURE = join(import.meta.dir, "../../dist/capability-loader/ServeSimLaunchFixture.app");
const APP = "dev.expo.serve-sim.launch-fixture";

const udid = e2eDevice();
const ready = udid !== null && existsSync(CLI_PATH) && existsSync(FIXTURE);
requireE2E("hardware keyboard shift", ready);
const describeWithSim = ready ? describe : describe.skip;

function cli(...args: string[]): string {
  return execFileSync("node", [CLI_PATH, ...args], { encoding: "utf8", timeout: 15_000 });
}

function simctl(...args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8", stdio: "pipe", timeout: 30_000 });
}

describeWithSim(`desktop Shift with the hardware keyboard off (sim ${udid ?? "<skipped>"})`, () => {
  let state: ServeSimDeviceState;
  let fixtureLog: string;
  const sockets: WebSocket[] = [];

  function fixtureLines(): string[] {
    try { return readFileSync(fixtureLog, "utf8").split("\n").filter(Boolean); }
    catch { return []; }
  }

  async function waitFor<T>(read: () => T, expected: T, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (read() === expected) return;
      await Bun.sleep(100);
    }
    expect(read()).toBe(expected);
  }

  async function openSocket(): Promise<WebSocket> {
    const socket = new WebSocket(
      state.wsUrl,
      state.token ? { headers: { Authorization: `Bearer ${state.token}` } } : undefined,
    );
    socket.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`WebSocket connection failed: ${state.wsUrl}`));
    });
    sockets.push(socket);
    return socket;
  }

  function send(socket: WebSocket, tag: number, payload: object): void {
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const message = new Uint8Array(1 + json.length);
    message[0] = tag;
    message.set(json, 1);
    socket.send(message);
  }

  async function typeLikeDesktop(socket: WebSocket, text: string): Promise<void> {
    for (const event of textToKeyEvents(text)) {
      send(socket, 0x06, event);
      await Bun.sleep(30);
    }
  }

  async function launchTextField(): Promise<number> {
    const start = fixtureLines().length;
    try { simctl("terminate", udid!, APP); } catch {}
    simctl("launch", udid!, APP, "--keyboard-test");
    await waitFor(() => fixtureLines().slice(start).some((line) => line.startsWith("keyboard-ready\t")), true);
    return start;
  }

  function lastText(start: number): string | undefined {
    return fixtureLines().slice(start).filter((line) => line.startsWith("text\t")).at(-1)?.split("\t")[2];
  }

  beforeAll(async () => {
    try { cli("--kill", udid!); } catch {}
    try { simctl("uninstall", udid!, APP); } catch {}
    simctl("install", udid!, FIXTURE);
    fixtureLog = join(simctl("get_app_container", udid!, APP, "data").trim(), "Documents/launches.tsv");

    const port = await freePortAsync();
    const detach = spawnSync("node", [CLI_PATH, "--detach", "-p", String(port), udid!], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 120_000,
    });
    if (detach.status !== 0 || !detach.stdout) {
      throw new Error(`serve-sim --detach failed (exit=${detach.status} signal=${detach.signal})\nstdout: ${detach.stdout}`);
    }
    state = parseDetachState<ServeSimDeviceState>(detach.stdout);
  }, 180_000);

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    try { cli("ui", "hardware-keyboard", "on", "-d", udid!); } catch {}
    await Bun.sleep(500);
  });

  afterAll(() => {
    try { cli("--kill", udid!); } catch {}
    try { simctl("terminate", udid!, APP); } catch {}
    try { simctl("uninstall", udid!, APP); } catch {}
  }, 60_000);

  test("Shift reaches a field with the hardware keyboard on", async () => {
    const desktop = await openSocket();
    const start = await launchTextField();
    await typeLikeDesktop(desktop, "Hi! 123");
    await waitFor(() => lastText(start), "Hi! 123");
  }, 60_000);

  test("Shift reaches a field after a touch client joins the session", async () => {
    const touch = await openSocket();
    send(touch, 0x0e, { enabled: false });
    const desktop = await openSocket();
    await Bun.sleep(1000);
    const start = await launchTextField();
    await typeLikeDesktop(desktop, "Hi! 123");
    await waitFor(() => lastText(start), "Hi! 123");
  }, 60_000);

  test("Shift reaches a field after the hardware keyboard is switched off", async () => {
    const desktop = await openSocket();
    cli("ui", "hardware-keyboard", "off", "-d", udid!);
    const start = await launchTextField();
    await typeLikeDesktop(desktop, "Hi! 123");
    await waitFor(() => lastText(start), "Hi! 123");
  }, 60_000);
});
