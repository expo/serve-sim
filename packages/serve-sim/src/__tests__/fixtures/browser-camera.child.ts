import { beforeEach, expect, mock, test } from "bun:test";

let sendResult = "sent";
let sent = 0;
let disconnected: (() => void) | undefined;
let cameraStopped: (() => void) | undefined;
mock.module("../../client/utils/exec", () => ({
  sendCameraFrame() { sent++; return sendResult; },
  stopCameraFrames() {},
  onCameraStopped(_udid: string, listener: () => void) {
    cameraStopped = listener;
    return () => { cameraStopped = undefined; };
  },
  onExecDisconnect(listener: () => void) {
    disconnected = listener;
    return () => { disconnected = undefined; };
  },
}));
const { startBrowserCamera } = await import("../../client/utils/browser-camera");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class Track extends EventTarget {
  label = "Test camera";
  stops = 0;
  stop() { this.stops++; }
}
let track: Track;
let errors: string[];
let media: () => Promise<unknown>;
let play: () => Promise<void>;
let controller: AbortController;
let encoded: (() => void) | undefined;
let holdEncoding = false;
const globals = globalThis as Record<string, unknown>;

beforeEach(() => {
  track = new Track();
  errors = [];
  sent = 0;
  sendResult = "sent";
  disconnected = undefined;
  cameraStopped = undefined;
  encoded = undefined;
  holdEncoding = false;
  controller = new AbortController();
  media = async () => ({ getTracks: () => [track], getVideoTracks: () => [track] });
  play = async () => {};
  globals.navigator = { mediaDevices: { getUserMedia: () => media() } };
  globals.document = {
    createElement(tag: string) {
      if (tag === "video") return { readyState: 2, videoWidth: 1920, videoHeight: 1080, play: () => play() };
      return {
        getContext: () => ({ drawImage() {} }),
        toBlob(callback: (blob: Blob) => void) {
          const complete = () => callback(new Blob([new Uint8Array([1, 2, 3])]));
          if (holdEncoding) encoded = complete;
          else complete();
        },
      };
    },
  };
});
const begin = () => startBrowserCamera({ udid: "DEVICE-A", signal: controller.signal, onError: (message) => errors.push(message) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

test("releases tracks when permission resolves after cancellation", async () => {
  const pending = deferred<unknown>();
  media = () => pending.promise;
  const opening = begin();
  controller.abort();
  pending.resolve({ getTracks: () => [track], getVideoTracks: () => [track] });
  await expect(opening).rejects.toThrow();
  expect(track.stops).toBe(1);
  expect(sent).toBe(0);
});

test("abort while video playback is pending stops tracks immediately", async () => {
  const pending = deferred<void>();
  play = () => pending.promise;
  const opening = begin();
  await flush();
  controller.abort();
  expect(track.stops).toBe(1);
  pending.resolve();
  await expect(opening).rejects.toThrow();
  expect(track.stops).toBe(1);
});

test("sends nothing until started and stops tracks exactly once", async () => {
  const session = await begin();
  await flush();
  expect(sent).toBe(0);
  session.start();
  await flush();
  expect(sent).toBe(1);
  session.stop();
  session.stop();
  controller.abort();
  expect(track.stops).toBe(1);
});

test("stopping during encoding discards the late frame", async () => {
  holdEncoding = true;
  const session = await begin();
  session.start();
  session.stop();
  encoded?.();
  await flush();
  expect(sent).toBe(0);
  expect(track.stops).toBe(1);
});

test("backpressure drops remain nonfatal", async () => {
  sendResult = "dropped";
  const session = await begin();
  session.start();
  await flush();
  expect(track.stops).toBe(0);
  expect(errors).toEqual([]);
  session.stop();
});

test("transport loss releases the camera immediately", async () => {
  const session = await begin();
  session.start();
  disconnected?.();
  expect(track.stops).toBe(1);
  expect(errors[0]).toContain("connection closed");
  session.stop();
  expect(track.stops).toBe(1);
});

test("an ended track stops the session and reports a reconnect action", async () => {
  const session = await begin();
  session.start();
  track.dispatchEvent(new Event("ended"));
  expect(track.stops).toBe(1);
  expect(errors[0]).toContain("reconnect");
  session.stop();
});

test("ownership loss releases tracks and explains how to reconnect", async () => {
  const session = await begin();
  session.start();
  cameraStopped?.();
  expect(track.stops).toBe(1);
  expect(errors[0]).toContain("another session");
  expect(cameraStopped).toBeUndefined();
  session.stop();
  expect(track.stops).toBe(1);
});
