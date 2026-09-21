import { describe, expect, test } from "bun:test";
import { duoFrameMatchesConfig, duoHomeIndicatorEdge, duoPoseRotation, duoStreamPoint, duoTextureRotation, stepDuoSpring } from "../client/components/duo-model-motion";

describe("Duo folding animation", () => {
  test("hinge movement is independent of refresh rate and never overshoots a settled target", () => {
    const run = (fps: number) => {
      let state = { value: 0, velocity: 0 };
      for (let frame = 0; frame < fps; frame++) {
        state = stepDuoSpring(state, 180, 1 / fps);
        expect(state.value).toBeGreaterThanOrEqual(0);
        expect(state.value).toBeLessThanOrEqual(180);
      }
      return state.value;
    };
    expect(run(30)).toBeCloseTo(run(120), 8);
    expect(run(60)).toBeGreaterThan(179.9);
  });

  test("an interrupted fold continues from its current position and velocity", () => {
    const moving = stepDuoSpring({ value: 180, velocity: 0 }, 0, 0.08);
    const reversed = stepDuoSpring(moving, 180, 1 / 120);
    expect(Math.abs(reversed.value - moving.value)).toBeLessThan(10);
    expect(reversed.value).toBeGreaterThan(0);
    let settled = reversed;
    for (let i = 0; i < 180; i++) settled = stepDuoSpring(settled, 180, 1 / 120);
    expect(settled.value).toBeCloseTo(180, 3);
  });

  test("closed presents the cover while laptop and tent have a horizontal hinge", () => {
    expect(duoPoseRotation(0, "closed")[1]).toBeGreaterThan(Math.PI / 2);
    expect(duoPoseRotation(180, "open")[2]).toBe(0);
    expect(duoPoseRotation(90, "laptop")[2]).toBe(Math.PI / 2);
    expect(duoPoseRotation(80, "tent")[0]).toBeGreaterThan(Math.PI / 2);
  });
});

describe("Duo live screen coordinates", () => {
  test("unrotated cover and inner buffers keep native touch coordinates", () => {
    expect(duoTextureRotation(true, 466, 678, "portrait")).toBe(0);
    expect(duoTextureRotation(false, 2088, 1488, "portrait")).toBe(0);
    expect(duoStreamPoint(0.25, 0.8, 0)).toEqual({ x: 0.25, y: 0.8 });
  });

  test("native inner portrait buffers rotate clockwise and raycasts invert that mapping", () => {
    const rotation = duoTextureRotation(false, 1488, 2088, "landscape_left");
    expect(rotation).toBe(Math.PI / 2);
    expect(duoTextureRotation(false, 702, 1000, "portrait")).toBe(Math.PI / 2);
    expect(duoStreamPoint(0.2, 0.7, rotation)).toEqual({ x: 0.7, y: 0.8 });
    expect(duoStreamPoint(0.2, 0.7, Math.PI / 2)).toEqual({ x: 0.7, y: 0.8 });
  });
});

describe("Duo home gestures", () => {
  test("tags the native edge matching the app home indicator after raycasting", () => {
    const portrait = { width: 702, height: 1000, orientation: "portrait" as const };
    const landscape = { ...portrait, orientation: "landscape_left" as const };
    expect(duoHomeIndicatorEdge({ x: 0.5, y: 0.96 }, portrait)).toBe(3);
    expect(duoHomeIndicatorEdge({ x: 0.96, y: 0.5 }, landscape)).toBe(4);
    expect(duoHomeIndicatorEdge({ x: 0.5, y: 0.96 }, landscape)).toBeUndefined();
    expect(duoHomeIndicatorEdge({ x: 0.04, y: 0.5 }, { ...portrait, orientation: "landscape_right" })).toBe(1);
    expect(duoHomeIndicatorEdge({ x: 0.5, y: 0.04 }, { ...portrait, orientation: "portrait_upside_down" })).toBe(2);
  });
});

describe("Duo display frame handoff", () => {
  const inner = { width: 702, height: 1000 };
  const cover = { width: 686, height: 1000 };

  test("retains the previous texture until pixels match the new active display", () => {
    expect(duoFrameMatchesConfig(686, 1000, inner)).toBe(false);
    expect(duoFrameMatchesConfig(702, 1000, cover)).toBe(false);
    expect(duoFrameMatchesConfig(702, 1000, inner)).toBe(true);
    expect(duoFrameMatchesConfig(686, 1000, cover)).toBe(true);
  });

  test("accepts transport scaling, quarter turns, and encoder pixel rounding", () => {
    expect(duoFrameMatchesConfig(351, 500, inner)).toBe(true);
    expect(duoFrameMatchesConfig(500, 351, inner)).toBe(true);
    expect(duoFrameMatchesConfig(224, 320, inner)).toBe(true);
    expect(duoFrameMatchesConfig(225, 320, inner)).toBe(true);
    expect(duoFrameMatchesConfig(220, 320, inner)).toBe(false);
    expect(duoFrameMatchesConfig(351, 500, { width: 1000, height: 702 })).toBe(true);
  });

  test("waits for usable decoded and reported dimensions", () => {
    for (const value of [0, -1, NaN, Infinity]) {
      expect(duoFrameMatchesConfig(value, 1000, inner)).toBe(false);
      expect(duoFrameMatchesConfig(702, value, inner)).toBe(false);
      expect(duoFrameMatchesConfig(702, 1000, { width: value, height: 1000 })).toBe(false);
      expect(duoFrameMatchesConfig(702, 1000, { width: 702, height: value })).toBe(false);
    }
  });
});
