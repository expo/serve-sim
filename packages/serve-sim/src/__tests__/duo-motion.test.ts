import { describe, expect, test } from "bun:test";
import { DUO_SETTLE_MS, duoPose, duoSliderPose, duoTransition, interpolateDuoPose } from "../client/utils/duo-motion";

describe("Device Hub reference motion", () => {
  test("cover/open turns keep the supporting right leaf flat instead of passing through Book", () => {
    for (const [from, to] of [[0, 180], [180, 0]]) {
      for (let t = 0; t <= 1; t += 0.025) {
        const pose = interpolateDuoPose(duoPose(from!), duoPose(to!), t);
        expect(pose.rightYaw).toBeCloseTo(0);
        expect(pose.leftYaw).toBeCloseTo(from === 0 ? 180 * (1 - t) : 180 * t);
      }
    }
  });
  test("a reversal continues from the current leaf transforms without a pose snap", () => {
    const interrupted = interpolateDuoPose(duoPose(0), duoPose(180), 0.4);
    expect(interpolateDuoPose(interrupted, duoPose(0), 0)).toEqual(interrupted);
    expect(interpolateDuoPose(interrupted, duoPose(0), 1)).toEqual(duoPose(0));
  });
  test("fits the measured opening edge instead of jumping into an ease-out", () => {
    const { duration, ease } = duoTransition(duoPose(0), duoPose(180));
    expect(duration).toBe(DUO_SETTLE_MS);
    for (const [seconds, progress] of [[0.1, 0.4], [0.2, 0.75], [0.3, 0.87], [0.4, 0.93], [0.6, 0.98]]) {
      expect(Math.abs(ease(seconds! * 1000 / DUO_SETTLE_MS) - progress!)).toBeLessThan(0.06);
    }
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
  });
  test("cover travel has consistent physical speed for Half Fold and Unfold", () => {
    const half = duoTransition(duoPose(0), duoPose(90)).duration;
    const open = duoTransition(duoPose(0), duoPose(180)).duration;
    expect(half / open).toBeGreaterThan(0.99);
  });
  test("closing passes edge-on halfway through, with gentle endpoints", () => {
    const { ease } = duoTransition(duoPose(180), duoPose(0));
    expect(ease(0.5)).toBe(0.5);
    expect(ease(0.1)).toBeLessThan(0.04);
    expect(ease(0.9)).toBeGreaterThan(0.96);
  });
  test("Book and Open use the same short symmetric motion in both directions", () => {
    for (const [from, to] of [[90, 180], [180, 90]]) {
      const { duration, ease } = duoTransition(duoPose(from!), duoPose(to!));
      expect(duration).toBe(500);
      expect(ease(0.25)).toBeCloseTo(0.15625);
      expect(ease(0.5)).toBe(0.5);
      expect(ease(0.75)).toBeCloseTo(0.84375);
    }
  });
  test("continuous angles match Device Hub's symmetric inner book after the display handoff", () => {
    for (const angle of [55, 60, 65, 71, 75, 80, 85, 90]) {
      const pose = duoSliderPose(angle);
      expect(pose.leftYaw).toBeCloseTo(-pose.rightYaw);
      expect(pose.offset).toBe(0);
    }
    expect(duoSliderPose(71).leftYaw).toBeCloseTo(46.611111, 5);
  });

  test("continuous geometry keeps the single device mostly frontal until the display handoff", () => {
    for (const angle of [0, 44, 45, 51, 52, 53, 54]) {
      const pose = duoSliderPose(angle, "cover");
      expect(pose.leftYaw).toBe(180 - angle / 2);
      expect(Math.abs(Math.cos(pose.leftYaw * Math.PI / 180))).toBeGreaterThan(0.89);
    }
    expect(duoSliderPose(55)).toEqual({ angle: 55, leftYaw: 56.388888888888886, rightYaw: -56.388888888888886, offset: 0 });
    const closing = duoSliderPose(54, "inner");
    expect(closing.leftYaw).toBeCloseTo(-closing.rightYaw);
    expect(closing.offset).toBe(0);
  });
});
