import { beforeEach, describe, expect, test } from "bun:test";
import { CrashStore, MAX_CRASHES, MAX_OCCURRENCES } from "../store";
import type { CrashEvent } from "../store";
import type { CrashReport } from "../report";

function report(overrides: Partial<CrashReport> = {}): CrashReport {
  const base: CrashReport = {
    incidentId: "INC-1",
    deviceUdid: "CD26E7DF-F2CE-4DCB-B950-2F062DE3FBB3",
    bundleId: "com.example.demo",
    appName: "Demo",
    procName: "Demo",
    appVersion: "1.0.0",
    buildVersion: "1",
    pid: 1,
    capturedAt: "2026-08-03 22:53:09.0000 -0700",
    capturedAtMs: Date.parse("2026-08-03 22:53:09.0000 -0700"),
    exceptionType: "EXC_CRASH",
    signal: "SIGABRT",
    terminationIndicator: "Abort trap: 6",
    faultingQueue: "com.apple.main-thread",
    culpritFrame: "Demo AppDelegate.boot()",
    frames: [],
    signature: "com.example.demo|EXC_CRASH|SIGABRT|Demo AppDelegate.boot()",
  };
  const merged = { ...base, ...overrides };
  // Keep the signature consistent with the culprit unless a test sets it directly.
  if (overrides.culpritFrame !== undefined && overrides.signature === undefined) {
    merged.signature = `com.example.demo|EXC_CRASH|SIGABRT|${overrides.culpritFrame}`;
  }
  return merged;
}

let clock = 0;
let store: CrashStore;

beforeEach(() => {
  clock = 1_000;
  store = new CrashStore(() => clock);
});

describe("CrashStore", () => {
  test("records a crash and reads it back by id", () => {
    const record = store.record(report(), "/tmp/a.ips");
    expect(record.count).toBe(1);
    expect(record.firstSeen).toBe(1_000);
    expect(record.lastSeen).toBe(1_000);
    expect(store.get(record.id)).toEqual(record);
    expect(store.list()).toHaveLength(1);
  });

  test("uses the first occurrence's incident id as a stable record id", () => {
    const first = store.record(report({ incidentId: "INC-1" }), "/tmp/a.ips");
    clock = 2_000;
    const second = store.record(report({ incidentId: "INC-2" }), "/tmp/b.ips");
    expect(second.id).toBe(first.id);
    expect(second.id).toBe("INC-1");
  });

  test("generates a non-colliding id when the report has no incident id", () => {
    const record = store.record(report({ incidentId: null }), "/tmp/a.ips");
    expect(record.id).toStartWith("no-incident-");
    expect(store.get(record.id)).not.toBeNull();
  });

  test("collapses repeat crashes into one record with a count", () => {
    store.record(report({ pid: 1 }), "/tmp/a.ips");
    clock = 2_000;
    store.record(report({ pid: 2 }), "/tmp/b.ips");
    clock = 3_000;
    const third = store.record(report({ pid: 3 }), "/tmp/c.ips");

    expect(store.list()).toHaveLength(1);
    expect(third.count).toBe(3);
    expect(third.firstSeen).toBe(1_000);
    expect(third.lastSeen).toBe(3_000);
  });

  test("tracks the newest occurrence's pid and path", () => {
    store.record(report({ pid: 1 }), "/tmp/a.ips");
    clock = 2_000;
    const second = store.record(report({ pid: 2 }), "/tmp/b.ips");
    expect(second.pid).toBe(2);
    expect(second.rawPath).toBe("/tmp/b.ips");
  });

  test("keeps distinct signatures apart", () => {
    store.record(report({ culpritFrame: "Demo A.boot()" }), "/tmp/a.ips");
    clock = 2_000;
    store.record(report({ culpritFrame: "Demo B.boom()" }), "/tmp/b.ips");
    expect(store.list()).toHaveLength(2);
  });

  test("lists the most recently seen crash first", () => {
    store.record(report({ culpritFrame: "Demo A.boot()" }), "/tmp/a.ips");
    clock = 2_000;
    store.record(report({ culpritFrame: "Demo B.boom()" }), "/tmp/b.ips");
    clock = 3_000;
    store.record(report({ culpritFrame: "Demo A.boot()" }), "/tmp/c.ips");

    expect(store.list().map((record) => record.culpritFrame)).toEqual([
      "Demo A.boot()",
      "Demo B.boom()",
    ]);
  });

  test("evicts the least recently seen crash past the cap", () => {
    for (let index = 0; index < MAX_CRASHES; index++) {
      clock = 1_000 + index;
      store.record(report({ culpritFrame: `Demo F${index}()` }), `/tmp/${index}.ips`);
    }
    expect(store.list()).toHaveLength(MAX_CRASHES);

    // Re-seeing the oldest signature makes it recent, so the next eviction spares it.
    clock = 9_000;
    store.record(report({ culpritFrame: "Demo F0()" }), "/tmp/again.ips");
    clock = 9_100;
    store.record(report({ culpritFrame: "Demo NEW()" }), "/tmp/new.ips");

    const frames = store.list().map((record) => record.culpritFrame);
    expect(store.list()).toHaveLength(MAX_CRASHES);
    expect(frames).toContain("Demo F0()");
    expect(frames).toContain("Demo NEW()");
    expect(frames).not.toContain("Demo F1()");
  });

  test("emits a crash event for a new signature and recurred for a repeat", () => {
    const events: CrashEvent[] = [];
    store.subscribe((event) => events.push(event));

    store.record(report(), "/tmp/a.ips");
    clock = 2_000;
    store.record(report({ pid: 2 }), "/tmp/b.ips");

    expect(events.map((event) => event.type)).toEqual(["crash", "recurred"]);
    expect(events[1]?.record.count).toBe(2);
  });

  test("still evicts when the clock is not a finite number", () => {
    const broken = new CrashStore(() => Number.NaN);
    for (let index = 0; index < MAX_CRASHES + 3; index++) {
      broken.record(report({ culpritFrame: `Demo F${index}()` }), "/tmp/x.ips");
    }
    expect(broken.list()).toHaveLength(MAX_CRASHES);
  });

  test("hands out snapshots, not the stored record", () => {
    const source = report();
    const returned = store.record(source, "/tmp/a.ips");

    source.frames.push({ image: "late", symbol: "late", imageOffset: 0, appOwned: false });
    returned.count = 999;

    const stored = store.get(returned.id);
    expect(stored?.frames).toHaveLength(0);
    expect(stored?.count).toBe(1);
    expect(store.list()[0]?.count).toBe(1);
  });

  test("keeps the log tail it was given", () => {
    const record = store.record(report(), "/tmp/a.ips", ['{"m":"before crash"}']);
    expect(record.logTail).toEqual(['{"m":"before crash"}']);
  });

  test("defaults the log tail to empty when none is available", () => {
    expect(store.record(report(), "/tmp/a.ips").logTail).toEqual([]);
  });

  test("replaces the log tail on a recurrence with the newer context", () => {
    store.record(report(), "/tmp/a.ips", ["old"]);
    clock = 2_000;
    expect(store.record(report(), "/tmp/b.ips", ["new"]).logTail).toEqual(["new"]);
  });

  test("keeps the earlier log tail when a recurrence has none", () => {
    store.record(report(), "/tmp/a.ips", ["old"]);
    clock = 2_000;
    expect(store.record(report(), "/tmp/b.ips", []).logTail).toEqual(["old"]);
  });

  test("keeps each repeat as its own occurrence, newest last", () => {
    const firstFrames = [{ image: "Demo", symbol: "old()", imageOffset: 1, appOwned: true }];
    const secondFrames = [
      { image: "libsystem_kernel.dylib", symbol: "__pthread_kill", imageOffset: 2, appOwned: false },
      { image: "Demo", symbol: "old()", imageOffset: 1, appOwned: true },
    ];
    store.record(report({ pid: 1, frames: firstFrames }), "/tmp/a.ips", ["first tail"], "app-windowed");
    clock = 2_000;
    store.record(report({ pid: 2, frames: secondFrames }), "/tmp/b.ips", ["second tail"], "app-windowed");

    const [record] = store.list();
    expect(record?.count).toBe(2);
    expect(record?.occurrences.map((o) => o.pid)).toEqual([1, 2]);
    expect(record?.occurrences.map((o) => o.logTail)).toEqual([["first tail"], ["second tail"]]);
    expect(record?.occurrences.map((o) => o.rawPath)).toEqual(["/tmp/a.ips", "/tmp/b.ips"]);
    expect(record?.occurrences[0]?.frames).toEqual(firstFrames);
    expect(record?.occurrences[1]?.frames).toEqual(secondFrames);
    expect(record?.frames).toEqual(secondFrames);
  });

  test("caps retained occurrences while count keeps the true total", () => {
    for (let index = 0; index < MAX_OCCURRENCES + 3; index++) {
      clock = 1_000 + index;
      store.record(report({ pid: index }), `/tmp/${index}.ips`);
    }

    const [record] = store.list();
    expect(record?.count).toBe(MAX_OCCURRENCES + 3);
    expect(record?.occurrences).toHaveLength(MAX_OCCURRENCES);
    // The oldest are dropped, not the newest.
    expect(record?.occurrences.at(-1)?.pid).toBe(MAX_OCCURRENCES + 2);
  });

  test("hands out occurrence snapshots, not the stored arrays", () => {
    const returned = store.record(
      report({ frames: [{ image: "Demo", symbol: "boot()", imageOffset: 0, appOwned: true }] }),
      "/tmp/a.ips",
      ["line"],
      "app-windowed"
    );
    returned.occurrences[0]!.logTail.push("injected");
    returned.occurrences[0]!.frames.push({
      image: "late",
      symbol: "late()",
      imageOffset: 1,
      appOwned: false,
    });

    expect(store.list()[0]?.occurrences[0]?.logTail).toEqual(["line"]);
    expect(store.list()[0]?.occurrences[0]?.frames).toEqual([
      { image: "Demo", symbol: "boot()", imageOffset: 0, appOwned: true },
    ]);
  });

  test("keeps recording when a listener throws", () => {
    const delivered: CrashEvent[] = [];
    store.subscribe(() => {
      throw new Error("closed socket");
    });
    store.subscribe((event) => delivered.push(event));

    expect(() => store.record(report(), "/tmp/a.ips")).not.toThrow();
    expect(delivered).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
  });

  test("stops delivering events after unsubscribe", () => {
    const events: CrashEvent[] = [];
    const unsubscribe = store.subscribe((event) => events.push(event));
    store.record(report(), "/tmp/a.ips");
    unsubscribe();
    clock = 2_000;
    store.record(report({ culpritFrame: "Demo B.boom()" }), "/tmp/b.ips");
    expect(events).toHaveLength(1);
  });
});
