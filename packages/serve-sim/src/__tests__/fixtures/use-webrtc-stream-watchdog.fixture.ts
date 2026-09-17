import { expect, mock, test } from "bun:test";

let effects: (() => void | (() => void))[] = [];
let updates: unknown[] = [];
let pendingStats: { resolve: (value: Map<string, unknown>) => void }[] = [];
let peers: FakePeer[] = [];
let closed = 0;
let visibility: "visible" | "hidden" = "visible";
let visibilityListener: (() => void) | undefined;
let nextTimer = 0;
const timers = new Map<number, { callback: () => void; delay: number }>();

class FakePeer {
  connectionState = "connected";
  iceGatheringState = "complete";
  localDescription = { type: "offer", sdp: "a=fmtp:102 profile-level-id=42e01f" };
  ontrack?: (event: { track: object; streams: object[] }) => void;
  constructor() { peers.push(this); }
  addTransceiver() { return {}; }
  async createOffer() { return this.localDescription; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  getStats() {
    return new Promise<Map<string, unknown>>((resolve) => pendingStats.push({ resolve }));
  }
  close() { closed += 1; }
}

mock.module("react", () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [value, (update: unknown) => updates.push(update)],
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
}));

Object.assign(globalThis, {
  document: {
    get visibilityState() { return visibility; },
    addEventListener(name: string, listener: () => void) {
      if (name === "visibilitychange") visibilityListener = listener;
    },
    removeEventListener(name: string, listener: () => void) {
      if (name === "visibilitychange" && visibilityListener === listener) visibilityListener = undefined;
    },
  },
  window: {
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout(callback: () => void, delay: number) {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    clearTimeout(id: number) { timers.delete(id); },
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  RTCPeerConnection: FakePeer,
  RTCRtpReceiver: { getCapabilities: () => ({ codecs: [] }) },
  MediaStream: class {},
  fetch: async (input: string) => new Response(JSON.stringify(
    input.includes("/stats")
      ? { sessions: [{ framesEncoded: 0 }] }
      : { type: "answer", sdp: "" },
  )),
});

// Import after mocking React and the browser surface so this exercises the real hook.
const { useWebRtcStream } = await import("../../client/hooks/use-webrtc-stream");
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
let cleanup: (void | (() => void))[] = [];

async function start(visible: "visible" | "hidden" = "visible") {
  cleanup.forEach((stop) => stop?.());
  effects = [];
  updates = [];
  pendingStats = [];
  peers = [];
  closed = 0;
  visibility = visible;
  timers.clear();
  const hook = useWebRtcStream({
    offerUrl: "http://local/offer",
    closeUrl: "http://local/close",
    statsUrl: "http://local/stats",
    enabled: true,
  });
  cleanup = effects.map((effect) => effect());
  await flush();
  peers[0]?.ontrack?.({ track: {}, streams: [{}] });
  return hook;
}

function fireTimer() {
  const entry = timers.entries().next().value;
  if (!entry) throw new Error("Expected a watchdog timer");
  timers.delete(entry[0]);
  entry[1].callback();
  return entry[1].delay;
}

function resolveStats(framesReceived: number) {
  const read = pendingStats.shift();
  if (!read) throw new Error("Expected an inbound stats read");
  read.resolve(new Map([["video", {
    id: "video",
    type: "inbound-rtp",
    kind: "video",
    framesReceived,
    framesDecoded: framesReceived,
  }]]));
}

function failures() {
  return updates.filter((value): value is { kind: string } =>
    typeof value === "object" && value !== null && "kind" in value);
}

test("first-frame watchdog pauses while hidden and restarts on resume", async () => {
  const hook = await start("hidden");
  expect(timers.size).toBe(0);
  visibility = "visible";
  visibilityListener?.();
  expect(fireTimer()).toBe(4_000);
  await flush();
  resolveStats(10);
  await flush();
  visibility = "hidden";
  visibilityListener?.();
  expect(timers.size).toBe(0);
  expect(failures()).toEqual([]);
  visibility = "visible";
  visibilityListener?.();
  hook.markFrameDecoded();
  expect(timers.size).toBe(0);
  expect(failures()).toEqual([]);
});

test("first-frame decision uses connection state after getStats resolves", async () => {
  await start();
  expect(fireTimer()).toBe(4_000);
  await flush();
  peers[0]!.connectionState = "disconnected";
  resolveStats(0);
  await flush();
  expect(failures()).toEqual([]);
  expect(updates).toContain("WebRTC did not establish a video path. Retrying...");
});

test("a hung first-frame stats read reaches a finite failure decision", async () => {
  await start();
  expect(fireTimer()).toBe(4_000);
  await flush();
  expect(pendingStats).toHaveLength(1);
  expect(fireTimer()).toBe(4_000);
  await flush();
  expect(closed).toBe(1);
  expect(failures()).toMatchObject([{ kind: "codec" }]);
});
