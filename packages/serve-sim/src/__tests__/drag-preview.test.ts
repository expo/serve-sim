import { describe, expect, test } from "bun:test";
import { DragPreviewTracker } from "../client/simulator/drag-preview";

describe("DragPreviewTracker", () => {
  test("is settled at zero while no drag is active", () => {
    const tracker = new DragPreviewTracker({ latencyMs: 240 });
    expect(tracker.offsetAt(1_000)).toEqual({ dx: 0, dy: 0, settled: true });
  });

  test("young drags shift by the full finger delta", () => {
    // The remote content cannot have moved yet, so the preview carries all of it.
    const tracker = new DragPreviewTracker({ latencyMs: 240 });
    tracker.begin(0, 100, 100);
    tracker.move(50, 150, 90);
    const offset = tracker.offsetAt(60);
    expect(offset.dx).toBe(50);
    expect(offset.dy).toBe(-10);
    expect(offset.settled).toBe(false);
  });

  test("a steady drag settles at latency times velocity", () => {
    const tracker = new DragPreviewTracker({ latencyMs: 240 });
    tracker.begin(0, 0, 0);
    for (let t = 16; t <= 1_000; t += 16) tracker.move(t, t, 0); // 1 px/ms
    const offset = tracker.offsetAt(1_000);
    // The window is the drag-follow latency: the server already shows motion
    // older than that, so only the last 240 ms of travel is previewed.
    expect(offset.dx).toBeGreaterThan(220);
    expect(offset.dx).toBeLessThanOrEqual(240);
  });

  test("holding still drains the preview as the server catches up", () => {
    const tracker = new DragPreviewTracker({ latencyMs: 240 });
    tracker.begin(0, 0, 0);
    tracker.move(100, 200, 0);
    // Finger holds; 300 ms later the server has rendered everything.
    const offset = tracker.offsetAt(420);
    expect(offset.dx).toBe(0);
    expect(offset.settled).toBe(false); // still active, just aligned
  });

  test("release decays the remaining offset to zero", () => {
    const tracker = new DragPreviewTracker({ latencyMs: 240, releaseDecayMs: 120 });
    tracker.begin(0, 0, 0);
    tracker.move(100, 240, 0);
    const before = tracker.offsetAt(110).dx;
    expect(before).toBeGreaterThan(200);
    tracker.end(110);

    const after1 = tracker.offsetAt(230); // one decay constant later
    expect(after1.dx).toBeLessThan(before / 2);
    expect(after1.settled).toBe(false);

    const after2 = tracker.offsetAt(110 + 120 * 8);
    expect(after2.dx).toBe(0);
    expect(after2.settled).toBe(true);
  });

  test("a new begin resets any decaying offset", () => {
    const tracker = new DragPreviewTracker({ latencyMs: 240 });
    tracker.begin(0, 0, 0);
    tracker.move(100, 240, 0);
    tracker.end(110);
    tracker.begin(150, 500, 500);
    expect(tracker.offsetAt(151)).toEqual({ dx: 0, dy: 0, settled: false });
    tracker.move(200, 540, 500);
    expect(tracker.offsetAt(210).dx).toBe(40);
  });

  test("ending without a begin is a no-op", () => {
    const tracker = new DragPreviewTracker({ latencyMs: 240 });
    tracker.end(50);
    expect(tracker.offsetAt(60)).toEqual({ dx: 0, dy: 0, settled: true });
  });
});
