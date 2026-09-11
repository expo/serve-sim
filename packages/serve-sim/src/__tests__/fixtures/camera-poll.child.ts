import { afterEach, expect, mock, test } from "bun:test";
import * as React from "react";

type Effect = { deps: readonly unknown[]; cleanup?: () => void };
const slots: unknown[] = [];
let slot = 0;
let pendingEffects: (() => void)[] = [];
let setters = 0;
let stops = 0;
const hostActions: string[] = [];
let status: unknown = null;
let poll: (() => void) | undefined;
let pagehide: (() => void) | undefined;
let openCamera = async () => ({ label: "Test camera", start() {}, stop() { stops++; } });
const cleanups: (() => void)[] = [];
const same = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
  !!left && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

mock.module("react", () => ({
  ...React,
  useState<T>(initial: T | (() => T)) {
    const index = slot++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [slots[index], (next: T | ((current: T) => T)) => {
      setters++;
      slots[index] = typeof next === "function" ? (next as (current: T) => T)(slots[index] as T) : next;
    }];
  },
  useRef<T>(initial: T) {
    const index = slot++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  },
  useCallback<T>(callback: T, deps: readonly unknown[]) {
    const index = slot++;
    const previous = slots[index] as { callback: T; deps: readonly unknown[] } | undefined;
    if (!same(previous?.deps, deps)) slots[index] = { callback, deps };
    return (slots[index] as { callback: T }).callback;
  },
  useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
    const index = slot++;
    const previous = slots[index] as Effect | undefined;
    if (same(previous?.deps, deps)) return;
    pendingEffects.push(() => {
      previous?.cleanup?.();
      const cleanup = effect() || undefined;
      slots[index] = { deps, cleanup };
      if (cleanup) cleanups.push(cleanup);
    });
  },
}));
mock.module("../../client/utils/exec", () => ({
  runHostAction: async (action: string) => {
    hostActions.push(action);
    return { exitCode: 0, stdout: "", stderr: "" };
  },
  stopCameraFrames() {},
}));
mock.module("../../client/utils/browser-camera", () => ({
  BROWSER_CAMERA_UNSUPPORTED: "unsupported",
  browserCameraSupported: () => true,
  browserCameraErrorMessage: (error: unknown) => String(error),
  startBrowserCamera: () => openCamera(),
}));
const globals = globalThis as Record<string, unknown>;
globals.window = {
  __SIM_PREVIEW__: { cameraStatusEndpoint: "/status" },
  addEventListener(name: string, callback: () => void) { if (name === "pagehide") pagehide = callback; },
  removeEventListener() {},
};
globals.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
globals.fetch = async () => status === null ? new Response("unavailable", { status: 503 }) : Response.json(status);
globals.setInterval = (callback: () => void) => { poll = callback; return 1; };
globals.clearInterval = () => { poll = undefined; };
const { CameraTool } = await import("../../client/components/camera-tool");
let tree: unknown;
function render() {
  slot = 0;
  pendingEffects = [];
  tree = CameraTool({ udid: "DEVICE-A" });
  for (const effect of pendingEffects) effect();
}
function findProps(node: unknown, key: string, value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findProps(child, key, value);
      if (found) return found;
    }
  }
  if (node && typeof node === "object" && "props" in node) {
    const props = node.props as Record<string, unknown>;
    if (props[key] === value) return props;
    return findProps(props.children, key, value);
  }
}
function click(key: string, value: string) {
  const props = findProps(tree, key, value);
  expect(props).toBeDefined();
  (props!.onClick as () => void)();
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  slots.length = 0;
  setters = 0;
  stops = 0;
  status = null;
  hostActions.length = 0;
});

test("a failed initial poll does not consume restoration", async () => {
  render();
  await flush();
  expect(setters).toBe(0);
  status = { alive: true, source: "image", arg: "/tmp/restored.png", mirror: "off" };
  poll?.();
  await flush();
  render();
  expect(findProps(tree, "fileName", "restored.png")).toBeDefined();
});

test("failed status polls preserve live browser tracks, explicit dead status stops them", async () => {
  status = { alive: true, connected: false, source: "stream", mirror: "off" };
  render();
  await flush();
  render();
  click("aria-label", "Choose camera source");
  render();
  click("children", "Browser camera");
  await flush();
  render();
  expect(findProps(tree, "webcamName", "Test camera")).toBeDefined();
  expect(stops).toBe(0);
  status = null;
  poll?.();
  await flush();
  expect(stops).toBe(0);
  status = { alive: false };
  poll?.();
  await flush();
  expect(stops).toBe(1);
});

test("pagehide cancels pending acquisition without leaving the panel busy", async () => {
  let complete!: (session: { label: string; start(): void; stop(): void }) => void;
  openCamera = () => new Promise((resolve) => { complete = resolve; });
  status = { alive: false };
  render();
  await flush();
  render();
  click("aria-label", "Choose camera source");
  render();
  click("children", "Browser camera");
  render();
  click("aria-label", "Enable");
  render();
  expect(findProps(tree, "aria-label", "Cancel")).toBeDefined();
  pagehide?.();
  render();
  expect(findProps(tree, "aria-label", "Enable")).toBeDefined();
  expect(findProps(tree, "aria-label", "Choose camera source")?.disabled).toBe(false);
  complete({ label: "Late camera", start() {}, stop() { stops++; } });
  await flush();
  expect(stops).toBe(1);
});

test("Cancel during permission acquisition does not disable another viewer's camera", async () => {
  let complete!: (session: { label: string; start(): void; stop(): void }) => void;
  openCamera = () => new Promise((resolve) => { complete = resolve; });
  status = { alive: false };
  render();
  await flush();
  render();
  click("aria-label", "Choose camera source");
  render();
  click("children", "Browser camera");
  render();
  click("aria-label", "Enable");
  render();
  click("aria-label", "Cancel");
  render();
  expect(findProps(tree, "aria-label", "Enable")).toBeDefined();
  complete({ label: "Late camera", start() {}, stop() { stops++; } });
  await flush();
  expect(stops).toBe(1);
  expect(hostActions).not.toContain("camera.stopWebcam");
  expect(hostActions).not.toContain("camera.inject");
});
