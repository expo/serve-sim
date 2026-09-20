import { describe, expect, test } from "bun:test";
import { flipLayoutInvert } from "../client/hooks/use-flip-layout";

describe("flipLayoutInvert", () => {
  const portrait = { left: 400, top: 80, width: 320, height: 480 };
  const landscape = { left: 310, top: 160, width: 500, height: 320 };

  test("rotates an ordinary device from portrait to landscape around the center", () => {
    const invert = flipLayoutInvert(portrait, landscape, -90);
    expect(invert?.transformOrigin).toBe("50% 50%");
    expect(invert?.transform).toContain("rotate(90deg)");
    expect(invert?.transform).toMatch(/scale\([\d.]+\)/);
    expect(invert?.transform).not.toMatch(/scale\([^)]+,/);
  });

  test("rotates the other way for landscape-left", () => {
    const invert = flipLayoutInvert(portrait, landscape, 90);
    expect(invert?.transform).toContain("rotate(-90deg)");
  });

  test("keeps anisotropic scale from the top-left for same-orientation resizes", () => {
    const bigger = { ...portrait, width: 400, height: 600 };
    const invert = flipLayoutInvert(portrait, bigger, 0);
    expect(invert?.transformOrigin).toBe("0 0");
    expect(invert?.transform).toMatch(/scale\([^)]+, [^)]+\)/);
  });
});
