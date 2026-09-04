import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import {
  createForegroundTrackerCache,
  frontmostAppFromLogOutput,
  frontmostAppViaRecentLogs,
  isUserFacingBundle,
  parseAppVisibilityLogMessage,
  type ForegroundApp,
} from "../foreground-tracker";

function fakeChild() {
  const stdout = Object.assign(new EventEmitter(), { destroy() {} });
  return Object.assign(new EventEmitter(), {
    stdout,
    killed: false,
    kill() {
      this.killed = true;
      return true;
    },
  });
}

function logChunk(bundleId: string, pid: number): Buffer {
  const eventMessage = `[app<${bundleId}>:${pid}] Setting process visibility to: Foreground`;
  return Buffer.from(JSON.stringify({ eventMessage }) + "\n");
}

function trackerWithFakeStream(restartDelayMs = 1000) {
  const children: ReturnType<typeof fakeChild>[] = [];
  const cache = createForegroundTrackerCache({
    spawnLogStream: () => {
      const child = fakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    frontmostApp: async () => null,
    restartDelayMs,
  });
  return { cache, children };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("frontmostAppFromLogOutput", () => {
  const line = (bundleId: string, pid: number, state: "Foreground" | "Background") =>
    JSON.stringify({
      eventMessage: `[app<${bundleId}>:${pid}] Setting process visibility to: ${state}`,
    });

  test("returns the latest foreground user app", () => {
    expect(frontmostAppFromLogOutput([
      line("dev.expo.A", 11, "Foreground"),
      line("dev.expo.A", 11, "Background"),
      line("dev.expo.B", 22, "Foreground"),
    ].join("\n"))).toEqual({ bundleId: "dev.expo.B", pid: 22 });
  });

  test("returns null when the latest user app was backgrounded", () => {
    expect(frontmostAppFromLogOutput([
      line("dev.expo.A", 11, "Foreground"),
      line("com.apple.WidgetRenderer", 99, "Foreground"),
      line("dev.expo.A", 11, "Background"),
    ].join("\n"))).toBeNull();
  });

  test("parses visibility state", () => {
    expect(
      parseAppVisibilityLogMessage(
        "[app<dev.expo.A>:11] Setting process visibility to: Background",
      ),
    ).toEqual({ bundleId: "dev.expo.A", pid: 11, foreground: false });
  });

  test("rejects a stale foreground event whose process exited", async () => {
    const output = line("dev.expo.A", 11, "Foreground");
    expect(
      await frontmostAppViaRecentLogs("UDID", {
        readLogs: async () => output,
        isProcessAlive: () => false,
      }),
    ).toBeNull();
  });
});

describe("isUserFacingBundle", () => {
  test("keeps regular apps, drops widgets/extensions/services", () => {
    expect(isUserFacingBundle("com.apple.mobilesafari")).toBe(true);
    expect(isUserFacingBundle("dev.expo.MyApp")).toBe(true);
    expect(isUserFacingBundle("com.apple.WidgetRenderer")).toBe(false);
    expect(isUserFacingBundle("dev.expo.MyApp.extension")).toBe(false);
    expect(isUserFacingBundle("com.example.CustomerService")).toBe(true);
    expect(isUserFacingBundle("com.acme.InCallUITest")).toBe(true);
    expect(isUserFacingBundle("com.apple.foo.Service")).toBe(false);
  });
});

describe("createForegroundTrackerCache", () => {
  test("tracks the latest user-facing app from the log feed", () => {
    const { cache, children } = trackerWithFakeStream();
    const seen: ForegroundApp[] = [];
    const sub = cache.subscribe("UDID", (app) => seen.push(app));

    children[0]!.stdout.emit("data", logChunk("dev.expo.A", 11));

    expect(cache.peek("UDID")).toEqual({ bundleId: "dev.expo.A", pid: 11 });
    expect(seen).toEqual([{ bundleId: "dev.expo.A", pid: 11 }]);
    sub.unsubscribe();
  });

  test("ignores non-user-facing bundles and exact repeats, but tracks a same-bundle relaunch", () => {
    const { cache, children } = trackerWithFakeStream();
    const seen: ForegroundApp[] = [];
    const sub = cache.subscribe("UDID", (app) => seen.push(app));
    const child = children[0]!;

    child.stdout.emit("data", logChunk("dev.expo.A", 11));
    child.stdout.emit("data", logChunk("dev.expo.A", 11));
    child.stdout.emit("data", logChunk("com.apple.WidgetRenderer", 99));
    child.stdout.emit("data", logChunk("dev.expo.A", 12));
    child.stdout.emit("data", logChunk("dev.expo.B", 22));

    expect(seen).toEqual([
      { bundleId: "dev.expo.A", pid: 11 },
      { bundleId: "dev.expo.A", pid: 12 },
      { bundleId: "dev.expo.B", pid: 22 },
    ]);
    sub.unsubscribe();
  });

  test("respawns the log stream when it exits while subscribers remain", async () => {
    const { cache, children } = trackerWithFakeStream(0);
    const sub = cache.subscribe("UDID");
    expect(children).toHaveLength(1);

    children[0]!.emit("exit");
    await tick();
    expect(children).toHaveLength(2);
    sub.unsubscribe();
  });

  test("does not respawn after an intentional stop", async () => {
    const { cache, children } = trackerWithFakeStream(0);
    const sub = cache.subscribe("UDID");
    sub.unsubscribe();

    children[0]!.emit("exit");
    await tick();
    expect(children).toHaveLength(1);
  });

  test("ref-counts duplicate callbacks independently", () => {
    const { cache, children } = trackerWithFakeStream();
    const callback = () => {};
    const a = cache.subscribe("UDID", callback);
    const b = cache.subscribe("UDID", callback);
    expect(children).toHaveLength(1);

    a.unsubscribe();
    expect(children[0]!.killed).toBe(false);
    b.unsubscribe();
    expect(children[0]!.killed).toBe(true);
  });

  test("shares one log stream per udid and stops it on last unsubscribe", () => {
    const { cache, children } = trackerWithFakeStream();
    const a = cache.subscribe("UDID");
    const b = cache.subscribe("UDID");
    expect(children).toHaveLength(1);

    a.unsubscribe();
    expect(children[0]!.killed).toBe(false);
    b.unsubscribe();
    expect(children[0]!.killed).toBe(true);
    expect(cache.peek("UDID")).toBeNull();
  });
});
