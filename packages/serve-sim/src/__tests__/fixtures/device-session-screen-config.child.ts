import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createServer, type Server } from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { NativeScreenInfo, MjpegFrame } from "../../native";

let screen: NativeScreenInfo;
let screenReads = 0;
let mjpeg: ((frame: MjpegFrame) => Promise<void>) | undefined;
const routedScreens: number[] = [];
const hingeAngles: number[] = [];
const hingePoses: string[] = [];
const tableModes: boolean[] = [];
let hingePoseDelay = 0;
let hingeResult = true;
let hingeSupported = false;
let inputSetupError: Error | undefined;
const inputCalls: string[] = [];

// Keep NativeHid's real error handling in the loop; only replace the addon.
const addon = {
  SimHID: class {
    async setScreen(screenId: number) {
      await Bun.sleep(5);
      routedScreens.push(screenId);
      if (inputSetupError) throw inputSetupError;
    }
    async touch() { inputCalls.push("touch"); }
    async orientation() { inputCalls.push("orientation"); return true; }
    async supportsHingeAngle() { inputCalls.push("supportsHingeAngle"); return hingeSupported; }
    async setHingeAngle(angle: number) { hingeAngles.push(angle); return hingeResult; }
    async setTableMode(enabled: boolean) { tableModes.push(enabled); return hingeResult; }
    async setHingePose(pose: string) {
      hingePoses.push(pose);
      await Bun.sleep(hingePoseDelay);
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

mock.module("../../native", () => ({
  NativeCapture: class {
    async start() {}
    async stop() {}
    async screenSize() { screenReads++; return { ...screen }; }
    async subscribeMjpeg(callback: typeof mjpeg) { mjpeg = callback; return async () => {}; }
  },
  NativeHid,
  Orientation: { portrait: 1, portraitUpsideDown: 2, landscapeRight: 3, landscapeLeft: 4 },
  axDescribeAsync: async () => "{}",
  axFrontmostAsync: async () => "{}",
}));
mock.module("../../ui-settings", () => ({
  clearDeviceOptionState() {},
  setUiOption: async () => {},
}));

const { DeviceSession } = await import("../../device-session");
let session: InstanceType<typeof DeviceSession> | undefined;
let server: Server | undefined;
let wsServer: WebSocketServer | undefined;
let ws: WebSocket | undefined;
let errorLog: ReturnType<typeof spyOn<typeof console, "error">> | undefined;

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
  inputSetupError = setupError;
  inputCalls.length = 0;
  mjpeg = undefined;
  session = new DeviceSession("SCREEN-TEST");
  await session.start();
  server = createServer((req, res) => session!.handleMjpeg(req, res));
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

describe("native active screen config", () => {
  test.each([1, undefined])("streams after input setup fails with screen ID %s", async (screenId) => {
    errorLog = spyOn(console, "error").mockImplementation(() => {});
    const { configs, hingeResults, url } = await start(
      { width: 1398, height: 2034, orientation: "portrait", screenId },
      true,
      new Error("Digitizer symbols unavailable"),
    );
    await waitUntil(() => configs.length > 0);
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
      ws!.send(Buffer.concat([Buffer.from([0x0f]), Buffer.from(JSON.stringify({ angle: 90 }))]));
      await waitUntil(() => hingeResults.length === 1);
      expect(hingeResults[0]?.ok).toBe(false);
      expect(inputCalls).toEqual([]);
      expect(hingeAngles).toEqual([]);

      screen = { width: 2007, height: 2853, orientation: "landscape_left", screenId: 3 };
      await waitUntil(() => configs.at(-1)?.screenId === 3);
      expect(configs.at(-1)).toMatchObject({ width: 2007, height: 2853, orientation: "landscape_left" });
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(routedScreens).toEqual([screenId ?? 0]);
    } finally {
      controller.abort();
    }
  });

  test("seeds a booted Duo's orientation and routes input before advertising its screen", async () => {
    const { configs } = await start({ width: 2007, height: 2853, orientation: "landscape_left", screenId: 1 });
    await waitUntil(() => configs.length > 0);
    expect(configs[0]).toMatchObject({ width: 2007, height: 2853, orientation: "landscape_left", screenId: 1 });
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
    expect(configs.at(-1)).not.toHaveProperty("hingeAngle");
    expect(configs.at(-1)).not.toHaveProperty("tableMode");
  });
});
