import { describe, expect, test } from "bun:test";
import { createRotationCursor } from "../client/simulator/rotation-cursor";

describe("rotation request cursor", () => {
  test("advances past an app-declined pose despite delayed readback from an earlier request", () => {
    const cursor = createRotationCursor();
    expect(cursor.requestNext()).toBe("landscape_left");
    expect(cursor.requestNext()).toBe("portrait_upside_down");
    cursor.updateReadback("landscape_left");
    expect(cursor.requestNext()).toBe("landscape_right");
  });

  test("resumes following external rotation once the latest request is acknowledged", () => {
    const cursor = createRotationCursor();
    cursor.requestNext();
    cursor.requestNext();
    cursor.updateReadback("landscape_left");
    cursor.updateReadback("portrait_upside_down");
    cursor.updateReadback("portrait");
    expect(cursor.requestNext()).toBe("landscape_left");
  });

  test("starts from the device's current pose and ignores missing readback", () => {
    const cursor = createRotationCursor("landscape_right");
    expect(cursor.requestNext()).toBe("portrait");
    cursor.updateReadback(null);
    cursor.updateReadback(undefined);
    expect(cursor.requestNext()).toBe("landscape_left");
  });
});
