import { describe, expect, test } from "bun:test";
import type { CrashSummary } from "../crash/store";
import {
  applyCrashFrame,
  EMPTY_CRASH_LIST,
  parseCrashFrame,
  type CrashListState,
} from "../client/utils/crash-stream";

function crash(id: string, lastSeen: number): CrashSummary {
  return { id, lastSeen, count: 1 } as unknown as CrashSummary;
}

function replay(state: CrashListState, ...frames: Parameters<typeof applyCrashFrame>[1][]) {
  return frames.reduce(applyCrashFrame, state);
}

describe("applyCrashFrame", () => {
  test("keeps the newest crash first", () => {
    const state = replay(
      EMPTY_CRASH_LIST,
      { type: "crash", record: crash("A", 1_000) },
      { type: "crash", record: crash("B", 3_000) },
      { type: "crash", record: crash("C", 2_000) }
    );

    expect(state.crashes.map((entry) => entry.id)).toEqual(["B", "C", "A"]);
  });

  test("replaces a repeat in place rather than listing it twice", () => {
    const state = replay(
      EMPTY_CRASH_LIST,
      { type: "crash", record: crash("A", 1_000) },
      { type: "recurred", record: { ...crash("A", 2_000), count: 2 } }
    );

    expect(state.crashes).toHaveLength(1);
    expect(state.crashes[0]?.count).toBe(2);
  });

  test("drops a crash the device evicted", () => {
    const state = replay(
      EMPTY_CRASH_LIST,
      { type: "crash", record: crash("A", 1_000) },
      { type: "crash", record: crash("B", 2_000) },
      { type: "evicted", id: "A" }
    );

    expect(state.crashes.map((entry) => entry.id)).toEqual(["B"]);
  });

  test("a reconnect's list replaces rows the device no longer has", () => {
    const stale = replay(
      EMPTY_CRASH_LIST,
      { type: "crash", record: crash("gone", 1_000) },
      { type: "crash", record: crash("kept", 2_000) }
    );

    const reconnected = applyCrashFrame(stale, { type: "list", crashes: [crash("kept", 2_000)] });

    expect(reconnected.crashes.map((entry) => entry.id)).toEqual(["kept"]);
  });
});

describe("parseCrashFrame", () => {
  test("ignores anything that is not a frame", () => {
    expect(parseCrashFrame("not json")).toBeNull();
    expect(parseCrashFrame("null")).toBeNull();
    expect(parseCrashFrame(JSON.stringify({ nope: 1 }))).toBeNull();
    expect(parseCrashFrame(JSON.stringify({ type: "evicted", id: "A" }))).toEqual({
      type: "evicted",
      id: "A",
    });
  });
});
