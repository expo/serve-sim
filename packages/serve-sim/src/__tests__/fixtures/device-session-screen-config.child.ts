import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createServer, type Server } from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { NativeScreenInfo, MjpegFrame } from "../../native";

let screen: NativeScreenInfo;
let screenReads = 0;
let mjpeg: ((frame: MjpegFrame) => Promise<void>) | undefined;
let screenChanged: (() => Promise<void>) | undefined;
let screenReadGate: Promise<void> | undefined;
const routedScreens: number[] = [];
const hingeAngles: number[] = [];
const hingePoses: string[] = [];
const tableModes: boolean[] = [];
let hingePoseDelay = 0;
let hingePoseGate: Promise<void> | undefined;
let hingeResult = true;
let hingeSupported = false;
let nativeHingeState: { hingeAngle?: number; physicalOrientation?: string; tableMode?: boolean } = {};
let inputSetupError: Error | undefined;
let touchError: Error | undefined;
const inputCalls: string[] = [];
const keyEvents: { type: string; usage: number }[] = [];
const axCharacters: string[] = [];
let axFailures = 0;
let axDelay = 0;
let hardwareKeyboard = "on";
let hardwareKeyboardDelay = 0;
const hardwareKeyboardUpdatesStarted: string[] = [];
let hardwareKeyboardRevision = 0;

// Keep NativeHid's real error handling in the loop; only replace the addon.
const addon = {
  SimHID: class {
    async setScreen(screenId: number) {
      await Bun.sleep(5);
      routedScreens.push(screenId);
      if (inputSetupError) throw inputSetupError;
    }
    async touch() {
      inputCalls.push("touch");
      if (touchError) throw touchError;
    }
    async multiTouch() { inputCalls.push("multiTouch"); }
    async button() { inputCalls.push("button"); }
    async buttonHid() { inputCalls.push("buttonHid"); }
    async key(type: string, usage: number) {
      inputCalls.push("key");
      keyEvents.push({ type, usage });
    }
    async scroll() { inputCalls.push("scroll"); }
    async digitalCrown() { inputCalls.push("digitalCrown"); }
    async orientation() { inputCalls.push("orientation"); return true; }
    async supportsHingeAngle() { inputCalls.push("supportsHingeAngle"); return hingeSupported; }
    async setHingeAngle(angle: number) { inputCalls.push("setHingeAngle"); hingeAngles.push(angle); return hingeResult; }
    async memoryWarning() { inputCalls.push("memoryWarning"); }
    async softwareKeyboard() { inputCalls.push("softwareKeyboard"); }
    async caDebug() { inputCalls.push("caDebug"); return true; }
    async hingeState() { return { ...nativeHingeState }; }
    async setTableMode(enabled: boolean) { inputCalls.push("setTableMode"); tableModes.push(enabled); return hingeResult; }
    async setHingePose(pose: string) {
      inputCalls.push("setHingePose");
      hingePoses.push(pose);
      await Bun.sleep(hingePoseDelay);
      if (hingePoseGate) await hingePoseGate;
      return hingeResult;
    }
  },
};
const moduleExports = await import("module");
const originalCreateRequire = moduleExports.createRequire;
mock.module("module", () => ({
  ...moduleExports,
  createRequire: (url: string | URL) => {
    const require = originalCreateRequire(url);
    return Object.assign((path: string) => path.endsWith("serve-sim-native.node") ? addon : require(path), require);
  },
}));
const fsExports = await import("fs");
const originalExistsSync = fsExports.existsSync;
mock.module("fs", () => ({
  ...fsExports,
  existsSync: (path: Parameters<typeof originalExistsSync>[0]) =>
    String(path).endsWith("serve-sim-native.node") || originalExistsSync(path),
}));
const { NativeHid } = await import("../../native");

const inputCommands: Array<{
  name: string;
  call: (hid: InstanceType<typeof NativeHid>) => Promise<unknown>;
  result?: boolean;
}> = [
  { name: "touch", call: (hid) => hid.touch("begin", 0.5, 0.5, 1398, 2034) },
  { name: "multiTouch", call: (hid) => hid.multiTouch("begin", 0.2, 0.2, 0.8, 0.8, 1398, 2034) },
  { name: "button", call: (hid) => hid.button("home") },
  { name: "buttonHid", call: (hid) => hid.buttonHid(0x0c, 0xe9) },
  { name: "key", call: (hid) => hid.key("down", 4) },
  { name: "scroll", call: (hid) => hid.scroll(0, 100, 1398, 2034) },
  { name: "digitalCrown", call: (hid) => hid.digitalCrown(1) },
  { name: "orientation", call: (hid) => hid.orientation(4), result: true },
  { name: "supportsHingeAngle", call: (hid) => hid.supportsHingeAngle(), result: true },
  { name: "setHingeAngle", call: (hid) => hid.setHingeAngle(90), result: true },
  { name: "setHingePose", call: (hid) => hid.setHingePose("book"), result: true },
  { name: "setTableMode", call: (hid) => hid.setTableMode(true), result: true },
  { name: "memoryWarning", call: (hid) => hid.memoryWarning() },
  { name: "softwareKeyboard", call: (hid) => hid.softwareKeyboard() },
  { name: "caDebug", call: (hid) => hid.caDebug("color-blended-layers", true), result: true },
];

mock.module("../../native", () => ({
  NativeCapture: class {
    async start() {}
    async stop() {}
    async screenSize() { screenReads++; const value = { ...screen }; await screenReadGate; return value; }
    async subscribeScreenChanges(callback: typeof screenChanged) {
      screenChanged = callback;
      return async () => { screenChanged = undefined; };
    }
    async subscribeMjpeg(callback: typeof mjpeg) { mjpeg = callback; return async () => {}; }
  },
  NativeHid,
  Orientation: { portrait: 1, portraitUpsideDown: 2, landscapeRight: 3, landscapeLeft: 4 },
  axDescribeAsync: async () => "{}",
  axFrontmostAsync: async () => "{}",
  axTypeKeyboardCharacterAsync: async (_udid: string, character: string) => {
    axCharacters.push(character);
    if (axDelay) await Bun.sleep(axDelay);
    if (axFailures > 0) {
      axFailures--;
      return false;
    }
    inputCalls.push("axCharacter");
    return true;
  },
}));
mock.module("../../ui-settings", () => ({
  refreshDeviceOptionState: async () => {},
  getUiOption: async () => hardwareKeyboard,
  setUiOption: async (_udid: string, option: string, value: string) => {
    if (option === "hardware-keyboard") hardwareKeyboardUpdatesStarted.push(value);
    if (hardwareKeyboardDelay) await Bun.sleep(hardwareKeyboardDelay);
    if (option === "hardware-keyboard") hardwareKeyboard = value;
    return `revision-${++hardwareKeyboardRevision}`;
  },
  setUiOptionIfRevision: async (_udid: string, option: string, value: string, revision: string) => {
    if (revision !== `revision-${hardwareKeyboardRevision}`) return null;
    if (option === "hardware-keyboard") hardwareKeyboardUpdatesStarted.push(value);
    if (hardwareKeyboardDelay) await Bun.sleep(hardwareKeyboardDelay);
    if (option === "hardware-keyboard") hardwareKeyboard = value;
    return `revision-${++hardwareKeyboardRevision}`;
  },
}));

const { DeviceSession } = await import("../../device-session");
let session: InstanceType<typeof DeviceSession> | undefined;
let server: Server | undefined;
let wsServer: WebSocketServer | undefined;
let ws: WebSocket | undefined;
let errorLog: ReturnType<typeof spyOn<typeof console, "error">> | undefined;

beforeEach(() => {
  inputSetupError = undefined;
  touchError = undefined;
  inputCalls.length = 0;
  keyEvents.length = 0;
  axCharacters.length = 0;
  axFailures = 0;
  axDelay = 0;
  hardwareKeyboard = "on";
  hardwareKeyboardDelay = 0;
  hardwareKeyboardUpdatesStarted.length = 0;
  hardwareKeyboardRevision = 0;
  routedScreens.length = 0;
  hingeAngles.length = 0;
  hingePoses.length = 0;
  tableModes.length = 0;
  hingePoseDelay = 0;
  hingePoseGate = undefined;
  hingeResult = true;
  hingeSupported = true;
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for screen config");
    await Bun.sleep(10);
  }
}

async function start(initialScreen: NativeScreenInfo, supportsHingeAngle = false, setupError?: Error) {
  screen = initialScreen;
  screenReads = 0;
  routedScreens.length = 0;
  hingeAngles.length = 0;
  hingePoses.length = 0;
  tableModes.length = 0;
  hingePoseDelay = 0;
  hingeResult = true;
  hingeSupported = supportsHingeAngle;
  nativeHingeState = {};
  inputSetupError = setupError;
  inputCalls.length = 0;
  mjpeg = undefined;
  screenChanged = undefined;
  screenReadGate = undefined;
  session = new DeviceSession("SCREEN-TEST");
  await session.start();
  server = createServer((req, res) => req.url === "/config"
    ? session!.handleConfig(req, res)
    : session!.handleMjpeg(req, res));
  wsServer = new WebSocketServer({ server });
  wsServer.on("connection", (socket) => session!.attachHidSocket(socket));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing TCP address");
  const configs: Record<string, unknown>[] = [];
  const hingeResults: Record<string, unknown>[] = [];
  const controlResults: Record<string, unknown>[] = [];
  ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  ws.on("message", (data) => {
    const buffer = Buffer.from(data as Buffer);
    if (buffer[0] === 0x82) configs.push(JSON.parse(buffer.subarray(1).toString()));
    if (buffer[0] === 0x90) controlResults.push(JSON.parse(buffer.subarray(1).toString()));
    if (buffer[0] === 0x8f) hingeResults.push(JSON.parse(buffer.subarray(1).toString()));
  });
  await new Promise<void>((resolve, reject) => { ws!.once("open", resolve); ws!.once("error", reject); });
  return { configs, hingeResults, controlResults, url: `http://127.0.0.1:${address.port}` };
}

afterEach(() => {
  ws?.terminate();
  session?.close();
  wsServer?.close();
  server?.closeAllConnections();
  server?.close();
  errorLog?.mockRestore();
  errorLog = undefined;
});

describe("native input failure isolation", () => {
  test("failed setup latches every input method until a new handle is created", async () => {
    errorLog = spyOn(console, "error").mockImplementation(() => {});
    inputSetupError = new Error("Digitizer symbols unavailable");
    const failed = new NativeHid("SCREEN-TEST");
    await failed.setScreen(3);
    expect(failed.inputUnavailable).toBe(true);

    for (const { name, call, result } of inputCommands) {
      expect({ name, result: await call(failed) }).toEqual({ name, result: result === true ? false : undefined });
    }
    expect(inputCalls).toEqual([]);
    expect(hingeAngles).toEqual([]);
    expect(hingePoses).toEqual([]);
    expect(tableModes).toEqual([]);

    // The failed native setup task cannot recover. Metadata updates must not
    // retry it or re-enable partial input, even if capabilities become available.
    inputSetupError = undefined;
    await failed.setScreen(1);
    await failed.touch("begin", 0.5, 0.5, 1398, 2034);
    expect(routedScreens).toEqual([3]);
    expect(inputCalls).toEqual([]);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(failed.inputUnavailable).toBe(true);

    const recovered = new NativeHid("SCREEN-TEST");
    await recovered.setScreen(1);
    expect(recovered.inputUnavailable).toBe(false);
    for (const { name, call, result } of inputCommands) {
      expect({ name, result: await call(recovered) }).toEqual({ name, result });
    }
    expect(inputCalls).toEqual(inputCommands.map(({ name }) => name));
    expect(hingeAngles).toEqual([90]);
    expect(hingePoses).toEqual(["book"]);
    expect(tableModes).toEqual([true]);
    expect(routedScreens).toEqual([3, 1]);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  test("an individual input error does not latch setup failure", async () => {
    errorLog = spyOn(console, "error").mockImplementation(() => {});
    const hid = new NativeHid("SCREEN-TEST");
    await hid.setScreen(1);
    touchError = new Error("Could not convert parameter 0 to type String");
    await hid.touch("begin", 0.5, 0.5, 1398, 2034);
    expect(hid.inputUnavailable).toBe(false);
    touchError = undefined;
    await hid.key("down", 4);
    await hid.touch("begin", 0.5, 0.5, 1398, 2034);
    await hid.setScreen(3);
    expect(inputCalls).toEqual(["touch", "key", "touch"]);
    expect(routedScreens).toEqual([1, 3]);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls.flat().join(" ")).toContain("touch ignored bad input");
  });
});

describe("shifted keyboard routing", () => {
  const sendTo = (socket: WebSocket, tag: number, payload: object) => socket.send(Buffer.concat([
    Buffer.from([tag]), Buffer.from(JSON.stringify(payload)),
  ]));
  const send = (tag: number, payload: object) => sendTo(ws!, tag, payload);

  test("keeps HID input when the software keyboard is shown with hardware input connected", async () => {
    await start({ width: 1170, height: 2532 });
    inputCalls.length = 0;
    send(0x0c, {});
    send(0x06, { type: "down", usage: 4, key: "A", shifted: true });
    send(0x06, { type: "up", usage: 4 });
    await waitUntil(() => inputCalls.filter((call) => call === "key").length === 2);
    expect(axCharacters).toEqual([]);
  });

  test("preserves hardware keyboard state set before the session starts", async () => {
    hardwareKeyboard = "off";
    await start({ width: 1170, height: 2532 });
    inputCalls.length = 0;
    send(0x06, { type: "down", usage: 4, key: "A", shifted: true });
    send(0x06, { type: "up", usage: 4 });
    await waitUntil(() => axCharacters.length === 1);
    expect(inputCalls).not.toContain("key");
  });

  test("retries AX and suppresses HID key-up when hardware input is disconnected", async () => {
    await start({ width: 1170, height: 2532 });
    inputCalls.length = 0;
    hardwareKeyboardDelay = 30;
    send(0x0e, { enabled: false });
    axFailures = 1;
    send(0x06, { type: "down", usage: 4, key: "A", shifted: true });
    send(0x06, { type: "up", usage: 4 });
    await waitUntil(() => axCharacters.length === 2);
    await Bun.sleep(20);
    expect(axCharacters).toEqual(["A", "A"]);
    expect(inputCalls).not.toContain("key");
    hardwareKeyboardDelay = 0;
  });

  test("falls back to HID when AX rejects every character press", async () => {
    await start({ width: 1170, height: 2532 });
    inputCalls.length = 0;
    send(0x0e, { enabled: false });
    axFailures = 10;
    send(0x06, { type: "down", usage: 4, key: "A", shifted: true });
    send(0x06, { type: "up", usage: 4 });
    await waitUntil(() => keyEvents.length === 2);
    expect(axCharacters).toHaveLength(10);
    expect(keyEvents).toEqual([
      { type: "down", usage: 4 },
      { type: "up", usage: 4 },
    ]);
  });

  test("orders a hardware change before a shifted key from another client", async () => {
    const { url } = await start({ width: 1170, height: 2532 });
    const second = new WebSocket(url.replace("http:", "ws:"));
    await new Promise<void>((resolve, reject) => {
      second.once("open", resolve);
      second.once("error", reject);
    });
    hardwareKeyboardDelay = 30;
    send(0x0e, { enabled: false });
    await waitUntil(() => hardwareKeyboardUpdatesStarted.includes("off"));
    sendTo(second, 0x06, { type: "down", usage: 4, key: "A", shifted: true });
    sendTo(second, 0x06, { type: "up", usage: 4 });
    await waitUntil(() => axCharacters.length === 1);
    expect(inputCalls).not.toContain("key");
    hardwareKeyboardDelay = 0;
    second.terminate();
  });

  test("types a shifted character before a later touch from the same client", async () => {
    await start({ width: 1170, height: 2532 });
    inputCalls.length = 0;
    send(0x0e, { enabled: false });
    axDelay = 40;
    send(0x06, { type: "down", usage: 4, key: "A", shifted: true });
    send(0x03, { type: "begin", x: 0.5, y: 0.5 });
    await waitUntil(() => inputCalls.includes("touch"));
    expect(axCharacters).toEqual(["A"]);
    expect(inputCalls.indexOf("axCharacter")).toBeLessThan(inputCalls.indexOf("touch"));
  });

  test("keeps a key held until every client releases it", async () => {
    const { url } = await start({ width: 1170, height: 2532 });
    const first = ws!;
    const second = new WebSocket(url.replace("http:", "ws:"));
    await new Promise<void>((resolve, reject) => {
      second.once("open", resolve);
      second.once("error", reject);
    });

    sendTo(first, 0x06, { type: "down", usage: 225 });
    sendTo(second, 0x06, { type: "down", usage: 225 });
    await waitUntil(() => keyEvents.some((event) => event.type === "down" && event.usage === 225));
    first.terminate();
    await waitUntil(() => (session as unknown as { admittedHidSockets: Set<unknown> }).admittedHidSockets.size === 1);
    sendTo(second, 0x06, { type: "down", usage: 4 });
    sendTo(second, 0x06, { type: "up", usage: 4 });
    sendTo(second, 0x06, { type: "up", usage: 225 });
    await waitUntil(() => keyEvents.some((event) => event.type === "up" && event.usage === 225));

    expect(keyEvents).toEqual([
      { type: "down", usage: 225 },
      { type: "down", usage: 4 },
      { type: "up", usage: 4 },
      { type: "up", usage: 225 },
    ]);
    ws = second;
  });

  test("forwards repeated key downs without adding owners", async () => {
    await start({ width: 1170, height: 2532 });
    send(0x06, { type: "down", usage: 42 });
    send(0x06, { type: "down", usage: 42 });
    send(0x06, { type: "up", usage: 42 });
    await waitUntil(() => keyEvents.some((event) => event.type === "up" && event.usage === 42));
    expect(keyEvents).toEqual([
      { type: "down", usage: 42 },
      { type: "down", usage: 42 },
      { type: "up", usage: 42 },
    ]);
  });

  test("does not block another keyboard on a disconnected non-keyboard request", async () => {
    const { url } = await start({ width: 1170, height: 2532 }, true);
    let releaseHinge!: () => void;
    hingePoseGate = new Promise<void>((resolve) => { releaseHinge = resolve; });
    send(0x10, { requestId: 1, command: { control: "pose", value: "laptop" } });
    await waitUntil(() => hingePoses.length === 1);
    const closed = new Promise<void>((resolve) => ws!.once("close", () => resolve()));
    ws!.terminate();
    await closed;
    await waitUntil(() => (session as unknown as { admittedHidSockets: Set<unknown> }).admittedHidSockets.size === 0);
    const second = new WebSocket(url.replace("http:", "ws:"));
    await new Promise<void>((resolve, reject) => {
      second.once("open", resolve);
      second.once("error", reject);
    });
    ws = second;
    try {
      send(0x06, { type: "down", usage: 5 });
      await waitUntil(() => keyEvents.some((event) => event.type === "down" && event.usage === 5));
    } finally {
      releaseHinge();
    }
  });

  test("restores hardware input after a desktop client reconnects during cleanup", async () => {
    const { url } = await start({ width: 1170, height: 2532 });
    send(0x0e, { enabled: false });
    await waitUntil(() => hardwareKeyboard === "off");
    axDelay = 100;
    send(0x06, { type: "down", usage: 225 });
    send(0x06, { type: "down", usage: 4, key: "A", shifted: true });
    const closed = new Promise<void>((resolve) => ws!.once("close", () => resolve()));
    ws!.terminate();
    await closed;
    const second = new WebSocket(url.replace("http:", "ws:"));
    await new Promise<void>((resolve, reject) => {
      second.once("open", resolve);
      second.once("error", reject);
    });
    ws = second;
    send(0x06, { type: "down", usage: 5 });
    send(0x06, { type: "up", usage: 5 });
    await waitUntil(() => hardwareKeyboard === "on");
    await waitUntil(() => keyEvents.some((event) => event.type === "down" && event.usage === 5));
    const releasedShift = keyEvents.findIndex((event) => event.type === "up" && event.usage === 225);
    const reconnectedKey = keyEvents.findIndex((event) => event.type === "down" && event.usage === 5);
    expect(releasedShift).toBeGreaterThanOrEqual(0);
    expect(releasedShift).toBeLessThan(reconnectedKey);
  });

  test("ignores a hardware change that resumes after its client disconnects", async () => {
    const { url } = await start({ width: 1170, height: 2532 });
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
    (session as unknown as { captureStart: Promise<void> }).captureStart = captureGate;
    send(0x0e, { enabled: false });
    await Bun.sleep(10);
    const closed = new Promise<void>((resolve) => ws!.once("close", () => resolve()));
    ws!.terminate();
    await closed;
    await waitUntil(() => (session as unknown as { hidSockets: Set<unknown> }).hidSockets.size === 0);
    releaseCapture();
    const second = new WebSocket(url.replace("http:", "ws:"));
    await new Promise<void>((resolve, reject) => {
      second.once("open", resolve);
      second.once("error", reject);
    });
    ws = second;
    send(0x06, { type: "down", usage: 5 });
    await waitUntil(() => keyEvents.some((event) => event.type === "down" && event.usage === 5));
    expect(hardwareKeyboardUpdatesStarted).not.toContain("off");
    expect(hardwareKeyboard).toBe("on");
  });

  test("restores hardware input when a client disconnects during its change", async () => {
    await start({ width: 1170, height: 2532 });
    hardwareKeyboardDelay = 50;
    send(0x0e, { enabled: false });
    await waitUntil(() => hardwareKeyboardUpdatesStarted.includes("off"));
    const closed = new Promise<void>((resolve) => ws!.once("close", () => resolve()));
    ws!.terminate();
    await closed;
    await waitUntil(() => (session as unknown as { hidSockets: Set<unknown> }).hidSockets.size === 0);
    await waitUntil(() => hardwareKeyboard === "off");
    await waitUntil(() => hardwareKeyboard === "on");
    expect(hardwareKeyboardUpdatesStarted).toEqual(["off", "on"]);
  });

  test("does not restore hardware input for a client that only typed", async () => {
    hardwareKeyboard = "off";
    await start({ width: 1170, height: 2532 });
    send(0x06, { type: "down", usage: 5 });
    await waitUntil(() => keyEvents.some((event) => event.type === "down" && event.usage === 5));
    const closed = new Promise<void>((resolve) => ws!.once("close", () => resolve()));
    ws!.terminate();
    await closed;
    await Bun.sleep(30);
    expect(hardwareKeyboardUpdatesStarted).toEqual([]);
    expect(hardwareKeyboard).toBe("off");
  });

  test("does not overwrite a newer hardware-keyboard setting on disconnect", async () => {
    await start({ width: 1170, height: 2532 });
    send(0x0e, { enabled: false });
    await waitUntil(() => hardwareKeyboard === "off");
    hardwareKeyboardRevision++;
    const closed = new Promise<void>((resolve) => ws!.once("close", () => resolve()));
    ws!.terminate();
    await closed;
    await Bun.sleep(30);
    expect(hardwareKeyboardUpdatesStarted).toEqual(["off"]);
    expect(hardwareKeyboard).toBe("off");
  });

  test("bounds messages waiting for capture startup", async () => {
    await start({ width: 1170, height: 2532 });
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
    (session as unknown as { captureStart: Promise<void> }).captureStart = captureGate;
    const closed = new Promise<void>((resolve) => ws!.once("close", () => resolve()));
    for (let index = 0; index < 1030; index++) {
      send(0x0e, { enabled: index % 2 === 0 });
    }
    await Promise.race([
      closed,
      Bun.sleep(1500).then(() => { throw new Error("Timed out waiting for the startup queue to close"); }),
    ]);
    releaseCapture();
  });

  test("accepts a long shifted sequence at the supported sender pace", async () => {
    await start({ width: 1170, height: 2532 });
    axDelay = 20;
    send(0x0e, { enabled: false });
    for (let index = 0; index < 40; index++) {
      send(0x06, { type: "down", usage: 225 });
      send(0x06, { type: "down", usage: 4, key: "A", shifted: true });
      send(0x06, { type: "up", usage: 4 });
      send(0x06, { type: "up", usage: 225 });
      await Bun.sleep(4);
    }
    await waitUntil(() => axCharacters.length === 40);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
  });

  test("closes a client whose keyboard operation queue exceeds the input bound", async () => {
    await start({ width: 1170, height: 2532 });
    hardwareKeyboardDelay = 100;
    const closed = new Promise<void>((resolve) => ws!.once("close", () => resolve()));
    send(0x06, { type: "down", usage: 225 });
    for (let index = 0; index < 1030; index++) {
      send(0x0e, { enabled: index % 2 === 0 });
    }
    await Promise.race([
      closed,
      Bun.sleep(1500).then(() => { throw new Error("Timed out waiting for the overloaded input socket to close"); }),
    ]);
    hardwareKeyboardDelay = 0;
    await waitUntil(() => keyEvents.some((event) => event.type === "up" && event.usage === 225));
    await waitUntil(() => hardwareKeyboard === "on");
  });
});

describe("native active screen config", () => {
  test.each([1, undefined])("streams after input setup fails with screen ID %s", async (screenId) => {
    errorLog = spyOn(console, "error").mockImplementation(() => {});
    const { configs, hingeResults, url } = await start(
      { width: 1398, height: 2034, orientation: "portrait", screenId },
      true,
      new Error("Digitizer symbols unavailable"),
    );
    await waitUntil(() => configs.length > 0);
    expect(configs[0]).toMatchObject({ inputUnavailable: true });
    expect(await (await fetch(`${url}/config`)).json()).toMatchObject({ inputUnavailable: true });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls.flat().join(" ")).toContain("Digitizer symbols unavailable");
    expect(errorLog.mock.calls.flat().join(" ")).toContain("without input");
    expect(routedScreens).toEqual([screenId ?? 0]);

    const controller = new AbortController();
    try {
      const responsePromise = fetch(url, { signal: controller.signal });
      await waitUntil(() => !!mjpeg);
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
      await mjpeg!({ width: 900, height: 1280, data: jpeg });
      const response = await responsePromise;
      expect(response.status).toBe(200);
      const chunk = await response.body!.getReader().read();
      expect(Buffer.from(chunk.value!).includes(Buffer.from(jpeg))).toBe(true);

      ws!.send(Buffer.concat([Buffer.from([0x03]), Buffer.from(JSON.stringify({ type: "begin", x: 0.5, y: 0.5 }))]));
      ws!.send(Buffer.concat([Buffer.from([0x06]), Buffer.from(JSON.stringify({ type: "down", usage: 4 }))]));
      ws!.send(Buffer.concat([Buffer.from([0x0f]), Buffer.from(JSON.stringify({ angle: 90 }))]));
      await waitUntil(() => hingeResults.length === 1);
      expect(hingeResults[0]?.ok).toBe(false);
      expect(inputCalls).toEqual([]);
      expect(hingeAngles).toEqual([]);

      screen = { width: 2007, height: 2853, orientation: "landscape_left", screenId: 3 };
      await waitUntil(() => configs.at(-1)?.screenId === 3);
      expect(configs.at(-1)).toMatchObject({ width: 2007, height: 2853, orientation: "landscape_left", inputUnavailable: true });
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(routedScreens).toEqual([screenId ?? 0]);
    } finally {
      controller.abort();
    }
  });

  test("seeds a booted Duo's orientation and routes input before advertising its screen", async () => {
    const { configs } = await start({ width: 2007, height: 2853, orientation: "landscape_left", screenId: 1 });
    await waitUntil(() => configs.length > 0);
    expect(configs[0]).toMatchObject({ width: 2007, height: 2853, orientation: "landscape_left", screenId: 1, inputUnavailable: false });
    expect(routedScreens).toEqual([1]);
  });

  test("pushes external orientation and screen changes without reconnecting", async () => {
    const { configs } = await start({ width: 2007, height: 2853, orientation: "landscape_left", screenId: 1 });
    await waitUntil(() => configs.length > 0);
    screen = { width: 1170, height: 2532, orientation: "portrait", screenId: 0 };
    await waitUntil(() => configs.at(-1)?.screenId === 0);
    expect(configs.at(-1)).toMatchObject({ width: 1170, height: 2532, orientation: "portrait", screenId: 0 });
    expect(routedScreens).toEqual([1, 0]);
  });

  test("routes input from a screen-change notification before publishing the new panel", async () => {
    const { configs } = await start({ width: 1398, height: 2034, screenId: 1 });
    expect(screenChanged).toBeDefined();
    screen = { width: 2007, height: 2853, screenId: 3, orientation: "landscape_left" };
    await screenChanged!();
    expect(routedScreens).toEqual([1, 3]);
    expect(session!.screenConfig()).toMatchObject(screen);
    await waitUntil(() => configs.at(-1)?.screenId === 3);
  });

  test("re-reads a change received during an outstanding screen refresh", async () => {
    await start({ width: 1398, height: 2034, screenId: 1 });
    expect(screenChanged).toBeDefined();
    let release!: () => void;
    screenReadGate = new Promise<void>((resolve) => { release = resolve; });
    screen = { width: 2007, height: 2853, screenId: 3 };
    const first = screenChanged!();
    screen = { width: 1398, height: 2034, screenId: 1, orientation: "landscape_left" };
    const second = screenChanged!();
    screenReadGate = undefined;
    release();
    await Promise.all([first, second]);
    expect(session!.screenConfig()).toMatchObject(screen);
    expect(routedScreens.at(-1)).toBe(1);
  });

  test("unsubscribes screen notifications on close and ignores an already queued callback", async () => {
    await start({ width: 1398, height: 2034, screenId: 1 });
    expect(screenChanged).toBeDefined();
    const notify = screenChanged!;
    session!.close();
    await notify();
    expect(screenChanged).toBeUndefined();
    expect(routedScreens).toEqual([1]);
  });

  test("metadata refresh preserves the encoded dimensions", async () => {
    const { configs, url } = await start({ width: 2007, height: 2853, orientation: "landscape_left", screenId: 1 });
    const controller = new AbortController();
    const response = fetch(url, { signal: controller.signal }).catch(() => null);
    await waitUntil(() => !!mjpeg);
    await mjpeg!({ width: 900, height: 1280, data: new Uint8Array([1, 2]) });
    screen = { ...screen, orientation: "landscape_right" };
    await waitUntil(() => configs.at(-1)?.orientation === "landscape_right");
    expect(configs.at(-1)).toMatchObject({ width: 900, height: 1280, orientation: "landscape_right" });
    controller.abort();
    await response;
  });

  test("restores legacy HID routing when active screen metadata disappears", async () => {
    const { configs } = await start({ width: 2007, height: 2853, orientation: "landscape_left", screenId: 1 });
    await waitUntil(() => configs.length > 0);
    screen = { width: 2007, height: 2853 };
    await waitUntil(() => routedScreens.length === 2);
    await waitUntil(() => configs.length === 2);
    expect(routedScreens).toEqual([1, 0]);
    expect(configs.at(-1)).not.toHaveProperty("screenId");
    expect(configs.at(-1)?.orientation).toBe("landscape_left");
  });

  test("retains requested orientation with older native APIs and stops polling on close", async () => {
    const { configs } = await start({ width: 1170, height: 2532 });
    await waitUntil(() => configs.length > 0);
    ws!.send(Buffer.concat([Buffer.from([0x07]), Buffer.from(JSON.stringify({ orientation: "landscape_right" }))]));
    await waitUntil(() => configs.at(-1)?.orientation === "landscape_right");
    const readsBefore = screenReads;
    await waitUntil(() => screenReads > readsBefore);
    expect(configs.at(-1)?.orientation).toBe("landscape_right");
    expect(routedScreens).toEqual([0]);
    session!.close();
    const readsAtClose = screenReads;
    await Bun.sleep(350);
    expect(screenReads).toBe(readsAtClose);
  });

  test("waits for Duo's actual orientation instead of briefly rotating a locked app", async () => {
    const { configs } = await start({ width: 1398, height: 2034, orientation: "portrait", screenId: 1 }, true);
    await waitUntil(() => configs.at(-1)?.supportsHingeAngle === true);
    const readsBefore = screenReads;
    ws!.send(Buffer.concat([Buffer.from([0x07]), Buffer.from(JSON.stringify({ orientation: "landscape_left" }))]));
    await waitUntil(() => screenReads > readsBefore);
    expect(configs.every((config) => config.orientation === "portrait")).toBe(true);
    screen = { ...screen, orientation: "landscape_left" };
    await waitUntil(() => configs.at(-1)?.orientation === "landscape_left");
  });

  test("forwards hinge degrees and acknowledges native success", async () => {
    const { hingeResults, configs } = await start({ width: 2007, height: 2853 });
    for (const angle of [0, 90, 180]) {
      ws!.send(Buffer.concat([Buffer.from([0x0f]), Buffer.from(JSON.stringify({ angle }))]));
    }
    await waitUntil(() => hingeResults.length === 3);
    expect(hingeAngles).toEqual([0, 90, 180]);
    expect(hingeResults).toEqual([0, 90, 180].map((angle) => ({ ok: true, angle })));
    expect(configs.at(-1)).toMatchObject({ supportsHingeAngle: true, hingeAngle: 180 });
  });

  test("reports native hinge capability without assuming an initial angle", async () => {
    const { configs } = await start({ width: 2007, height: 2853 }, true);
    await waitUntil(() => configs.at(-1)?.supportsHingeAngle === true);
    expect(configs.at(-1)).not.toHaveProperty("hingeAngle");
  });

  test("rejects malformed hinge requests without sending native input", async () => {
    const { hingeResults } = await start({ width: 2007, height: 2853 });
    for (const angle of [-1, 181, "90", null]) {
      ws!.send(Buffer.concat([Buffer.from([0x0f]), Buffer.from(JSON.stringify({ angle }))]));
    }
    await waitUntil(() => hingeResults.length === 4);
    expect(hingeAngles).toEqual([]);
    expect(hingeResults.every((result) => result.ok === false && typeof result.error === "string")).toBe(true);
  });

  test("reports native hinge failure instead of acknowledging success", async () => {
    const { hingeResults, configs } = await start({ width: 2007, height: 2853 });
    hingeResult = false;
    ws!.send(Buffer.concat([Buffer.from([0x0f]), Buffer.from(JSON.stringify({ angle: 90 }))]));
    await waitUntil(() => hingeResults.length === 1);
    expect(hingeResults[0]).toMatchObject({ ok: false, angle: 90 });
    expect(hingeResults[0]?.error).toBeTruthy();
    expect(configs.at(-1)).not.toHaveProperty("hingeAngle");
  });
});


describe("physical hinge controls", () => {
  const send = (requestId: number, command: unknown) => ws!.send(Buffer.concat([
    Buffer.from([0x10]), Buffer.from(JSON.stringify({ requestId, command })),
  ]));

  test("acknowledges distinct poses and broadcasts them to every client", async () => {
    const { controlResults, configs } = await start({ width: 2007, height: 2853 }, true);
    send(1, { control: "pose", value: "laptop" });
    await waitUntil(() => controlResults.length === 1);
    expect(hingePoses).toEqual(["laptop"]);
    expect(controlResults[0]).toEqual({ requestId: 1, ok: true });
    expect(configs.at(-1)).toMatchObject({ hingeAngle: 90, hingePose: "laptop" });
    send(2, { control: "pose", value: "book" });
    await waitUntil(() => controlResults.length === 2);
    expect(configs.at(-1)).toMatchObject({ hingeAngle: 90, hingePose: "book" });
  });

  test("serializes presets and slider commands, including legacy angle clients", async () => {
    const { controlResults, hingeResults, configs } = await start({ width: 2007, height: 2853 }, true);
    hingePoseDelay = 40;
    send(1, { control: "pose", value: "tent" });
    send(2, { control: "angle", value: 81.5 });
    ws!.send(Buffer.concat([Buffer.from([0x0f]), Buffer.from(JSON.stringify({ angle: 82 }))]));
    await waitUntil(() => hingePoses.length === 1);
    expect(hingeAngles).toEqual([]);
    await waitUntil(() => controlResults.length === 2 && hingeResults.length === 1);
    expect(hingeAngles).toEqual([81.5, 82]);
    expect(configs.at(-1)).toMatchObject({ hingeAngle: 82, hingePose: null });
  });

  test("allows Table Mode only in an eligible known pose and always allows releasing it", async () => {
    const { controlResults, configs } = await start({ width: 2007, height: 2853 }, true);
    send(1, { control: "table", value: true });
    await waitUntil(() => controlResults.length === 1);
    expect(controlResults[0]?.ok).toBe(false);
    expect(tableModes).toEqual([]);
    send(2, { control: "pose", value: "tent" });
    await waitUntil(() => controlResults.length === 2);
    expect(configs.at(-1)).toMatchObject({ tableMode: true, tableModeAvailable: true });
    send(3, { control: "angle", value: 180 });
    await waitUntil(() => controlResults.length === 3);
    expect(configs.at(-1)).toMatchObject({ tableMode: false, tableModeAvailable: false });
    send(4, { control: "table", value: false });
    await waitUntil(() => controlResults.length === 4);
    expect(tableModes).toEqual([false]);
    expect(configs.at(-1)).toMatchObject({ tableMode: false, hingePose: null });
  });

  test("serializes rotation after a preset and clears its selected pose", async () => {
    const { controlResults, configs } = await start({ width: 2007, height: 2853 }, true);
    hingePoseDelay = 40;
    send(1, { control: "pose", value: "laptop" });
    ws!.send(Buffer.concat([Buffer.from([0x07]), Buffer.from(JSON.stringify({ orientation: "portrait" }))]));
    await waitUntil(() => hingePoses.length === 1);
    expect(inputCalls).not.toContain("orientation");
    await waitUntil(() => controlResults.length === 1 && inputCalls.includes("orientation") && configs.at(-1)?.hingePose === null);
    expect(configs.at(-1)).toMatchObject({ hingePose: null, tableModeAvailable: false });
  });

  test("rejects bad controls and request ids without native input", async () => {
    const { controlResults } = await start({ width: 2007, height: 2853 }, true);
    send(1, { control: "pose", value: "invalid" });
    send(2, { control: "angle", value: 181 });
    send(0.5, { control: "pose", value: "laptop" });
    await waitUntil(() => controlResults.length === 3);
    expect(controlResults.every((reply) => reply.ok === false)).toBe(true);
    expect(hingePoses).toEqual([]);
    expect(hingeAngles).toEqual([]);
  });

  test("reports native pose failure without claiming the requested state", async () => {
    const { controlResults, configs } = await start({ width: 2007, height: 2853 }, true);
    send(41, { control: "pose", value: "closed" });
    await waitUntil(() => controlResults.length === 1);
    hingeResult = false;
    send(42, { control: "pose", value: "laptop" });
    await waitUntil(() => controlResults.length === 2);
    expect(controlResults[1]).toMatchObject({ requestId: 42, ok: false });
    expect(controlResults[1]?.error).toBeTruthy();
    expect(configs.at(-1)?.hingePose).toBeNull();
    expect(configs.at(-1)?.hingeAngle).toBe(0);
    expect(configs.at(-1)).not.toHaveProperty("tableMode");
  });

  test("reads a partially applied pose back before acknowledging failure and accepts a Table Mode retry", async () => {
    const { controlResults, configs } = await start({ width: 1398, height: 2034, screenId: 1 }, true);
    send(1, { control: "pose", value: "closed" });
    await waitUntil(() => controlResults.length === 1);
    // The hinge and physical orientation moved, then the table sensor failed.
    hingeResult = false;
    nativeHingeState = { hingeAngle: 82.5, physicalOrientation: "landscape-left", tableMode: false };
    screen = { width: 2007, height: 2853, screenId: 3, orientation: "landscape_left" };
    send(2, { control: "pose", value: "tent" });
    await waitUntil(() => controlResults.length === 2);
    expect(controlResults[1]).toMatchObject({ ok: false });
    expect(session!.screenConfig()).toMatchObject({ hingeAngle: 82.5, hingePose: null, screenId: 3, tableModeAvailable: true });
    expect(configs.at(-1)).toMatchObject({ hingeAngle: 82.5, screenId: 3, tableMode: false });
    expect(routedScreens).toEqual([1, 3]);
    hingeResult = true;
    send(3, { control: "table", value: true });
    await waitUntil(() => controlResults.length === 3);
    expect(controlResults[2]).toMatchObject({ ok: true });
    expect(tableModes).toEqual([true]);
  });
});
