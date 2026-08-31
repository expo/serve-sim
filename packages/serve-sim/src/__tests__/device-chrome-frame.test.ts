import { describe, expect, test } from "bun:test";
import { snapChromeRect } from "../client/components/device-chrome-frame";
import type { DeviceKitChromeDescriptor } from "../client/utils/grid";

function chromeFixture(): DeviceKitChromeDescriptor {
  return {
    identifier: "test",
    frame: { width: 1000, height: 2000 },
    body: { x: 10, y: 20, width: 980, height: 1960 },
    screen: { x: 40, y: 80, width: 920, height: 1840 },
    insets: { top: 10, left: 10, bottom: 10, right: 10 },
    outerCornerRadius: 16,
    innerCornerRadius: 12,
    screenRadius: 10,
    compositeImage: "Composite",
    slice: null,
    corner: null,
    buttons: [],
  };
}

describe("snapChromeRect", () => {
  test("adjacent rects share an edge after snapping", () => {
    const chrome = chromeFixture();
    const container = { width: 401, height: 867 };
    const left = snapChromeRect(
      chrome,
      { x: 0, y: 0, width: 50, height: 100 },
      container,
    );
    const right = snapChromeRect(
      chrome,
      { x: 50, y: 0, width: 50, height: 100 },
      container,
    );
    expect(left.left + left.width).toBe(right.left);
  });
});
