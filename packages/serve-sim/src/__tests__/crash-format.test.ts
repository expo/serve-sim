import { describe, expect, test } from "bun:test";
import type { CrashFrame } from "../crash/report";
import {
  collapseSystemFrames,
  formatCrashAgo,
  remapOccurrenceIndex,
} from "../client/utils/crash-format";

function frame(appOwned: boolean, symbol = "sym"): CrashFrame {
  return { image: appOwned ? "Demo" : "libsystem", symbol, imageOffset: 0, appOwned };
}

describe("remapOccurrenceIndex", () => {
  test("finds the stamp whose path matches", () => {
    const times = [{ rawPath: "/a.ips" }, { rawPath: "/b.ips" }, { rawPath: "/c.ips" }];
    expect(remapOccurrenceIndex(times, "/b.ips")).toBe(1);
  });

  test("returns null when the occurrence has aged out of the window", () => {
    expect(remapOccurrenceIndex([{ rawPath: "/b.ips" }], "/a.ips")).toBeNull();
  });
});

describe("formatCrashAgo", () => {
  test("returns empty when the crash has no parseable time", () => {
    expect(formatCrashAgo(null, 10_000)).toBe("");
  });

  test("speaks in seconds, then minutes, then hours", () => {
    expect(formatCrashAgo(90_000, 100_000)).toBe("10s ago");
    expect(formatCrashAgo(0, 120_000)).toBe("2m ago");
    expect(formatCrashAgo(0, 3_600_000)).toBe("1h ago");
  });
});

describe("collapseSystemFrames", () => {
  test("leaves a pure app or pure system stack alone", () => {
    const app = [frame(/* appOwned */ true), frame(/* appOwned */ true)];
    const system = [frame(/* appOwned */ false), frame(/* appOwned */ false), frame(/* appOwned */ false)];
    expect(collapseSystemFrames(app).map((row) => row.kind)).toEqual(["frame", "frame"]);
    expect(collapseSystemFrames(system).map((row) => row.kind)).toEqual(["frame", "frame", "frame"]);
  });

  test("keeps the crashing instruction and folds the system run under it", () => {
    const frames = [
      frame(/* appOwned */ false, "kill"),
      frame(/* appOwned */ false),
      frame(/* appOwned */ false),
      frame(/* appOwned */ true, "crash()"),
      frame(/* appOwned */ true),
    ];
    const rows = collapseSystemFrames(frames);
    expect(rows).toMatchObject([
      { kind: "frame", index: 0, frame: { symbol: "kill" } },
      {
        kind: "collapsed",
        start: 1,
        count: 2,
        frames: [
          { index: 1, frame: { appOwned: false } },
          { index: 2, frame: { appOwned: false } },
        ],
      },
      { kind: "frame", index: 3, frame: { symbol: "crash()" } },
      { kind: "frame", index: 4, frame: { appOwned: true } },
    ]);
  });

  test("does not collapse a single system frame between app frames", () => {
    const rows = collapseSystemFrames([
      frame(/* appOwned */ true),
      frame(/* appOwned */ false),
      frame(/* appOwned */ true),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["frame", "frame", "frame"]);
  });

  test("collapses a trailing system run of two or more", () => {
    const rows = collapseSystemFrames([
      frame(/* appOwned */ true),
      frame(/* appOwned */ false),
      frame(/* appOwned */ false),
      frame(/* appOwned */ false),
    ]);
    expect(rows).toMatchObject([
      { kind: "frame", index: 0, frame: { appOwned: true } },
      {
        kind: "collapsed",
        start: 1,
        count: 3,
        frames: [
          { index: 1, frame: { appOwned: false } },
          { index: 2, frame: { appOwned: false } },
          { index: 3, frame: { appOwned: false } },
        ],
      },
    ]);
  });
});
