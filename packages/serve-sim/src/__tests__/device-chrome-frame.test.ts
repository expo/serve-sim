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
  const chrome = chromeFixture();
  const container = { width: 401, height: 867 };

  for (const dpr of [1, 2, 3]) {
    test(`adjacent rects share an edge at dpr ${dpr}`, () => {
      const left = snapChromeRect(chrome, { x: 0, y: 0, width: 50, height: 100 }, container, dpr);
      const right = snapChromeRect(chrome, { x: 50, y: 0, width: 50, height: 100 }, container, dpr);

      expect(left.left + left.width).toBe(right.left);
    });

    test(`every edge lands on the device-pixel grid at dpr ${dpr}`, () => {
      const rect = snapChromeRect(chrome, { x: 37, y: 91, width: 53, height: 107 }, container, dpr);

      for (const edge of [rect.left, rect.top, rect.left + rect.width, rect.top + rect.height]) {
        expect(Number.isInteger(edge * dpr)).toBe(true);
      }
    });
  }

  test("stays inside the container and keeps sizes non-negative", () => {
    const frameRect = { x: 0, y: 0, width: chrome.frame.width, height: chrome.frame.height };
    const full = snapChromeRect(chrome, frameRect, container, 2);

    expect(full.left).toBe(0);
    expect(full.top).toBe(0);
    expect(full.width).toBe(container.width);
    expect(full.height).toBe(container.height);
  });

  test("a zero-width rect snaps to zero, never to a negative size", () => {
    const empty = snapChromeRect(chrome, { x: 500, y: 500, width: 0, height: 0 }, container, 2);

    expect(empty.width).toBe(0);
    expect(empty.height).toBe(0);
  });
});
