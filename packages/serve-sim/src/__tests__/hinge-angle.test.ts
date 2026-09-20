import { describe, expect, test } from "bun:test";
import { duoDisplayForHingeAngle, isHingeAngle, orientationForHingeAngle, foldLeafYaw, INNER_BOOK_HALF_DEG, parseHingeAngle, HINGE_POSITIONS } from "../hinge-angle";

describe("hinge angle", () => {
  test("accepts Device Hub's three fold positions", () => {
    expect(HINGE_POSITIONS.map((position) => position.angle)).toEqual([0, 90, 180]);
    expect(isHingeAngle(0)).toBe(true);
    expect(isHingeAngle(90)).toBe(true);
    expect(isHingeAngle(180)).toBe(true);
    expect(isHingeAngle(-1)).toBe(false);
    expect(isHingeAngle(181)).toBe(false);
  });

  test("parses named and numeric fold positions", () => {
    expect(parseHingeAngle("fold")).toBe(0);
    expect(parseHingeAngle("half")).toBe(90);
    expect(parseHingeAngle("unfold")).toBe(180);
    expect(parseHingeAngle("90")).toBe(90);
    expect(parseHingeAngle("nope")).toBeUndefined();
  });

  test("uses Device Hub's directional display thresholds without turning the device", () => {
    expect(orientationForHingeAngle(0)).toBe("portrait");
    expect(orientationForHingeAngle(54, "portrait")).toBe("portrait");
    expect(orientationForHingeAngle(55)).toBe("landscape_left");
    expect(orientationForHingeAngle(54, "landscape_left")).toBe("portrait");
    expect(orientationForHingeAngle(46, "landscape_left")).toBe("portrait");
    expect(orientationForHingeAngle(45, "landscape_left")).toBe("portrait");
    expect(duoDisplayForHingeAngle(54, "cover")).toBe("cover");
    expect(duoDisplayForHingeAngle(54, "inner")).toBe("cover");
    expect(orientationForHingeAngle(90)).toBe("landscape_left");
    expect(orientationForHingeAngle(180)).toBe("landscape_left");
  });

  test("opens the inner book from edge-on through a shallow half-fold to flat", () => {
    expect(foldLeafYaw(0)).toBe(90);
    expect(foldLeafYaw(90)).toBe(INNER_BOOK_HALF_DEG);
    expect(foldLeafYaw(180)).toBe(0);
    expect(foldLeafYaw(undefined)).toBe(90);
  });
});
