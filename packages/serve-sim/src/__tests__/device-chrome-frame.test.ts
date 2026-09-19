import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DeviceKitChrome,
  deviceKitChromeForScreen,
  deviceKitScreenRadius,
  snapChromeRect,
} from "../client/components/device-chrome-frame";
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

describe("deviceKitChromeForScreen", () => {
  test("selects the active screen's descriptor and falls back for unknown screens", () => {
    const inner = { ...chromeFixture(), identifier: "inner", screenId: 3 };
    const chrome = { ...chromeFixture(), screenId: 1, displayVariants: { 3: inner } };

    expect(deviceKitChromeForScreen(chrome, 3)).toBe(inner);
    expect(deviceKitChromeForScreen(chrome, 1)).toBe(chrome);
    expect(deviceKitChromeForScreen(chrome, 99)).toBe(chrome);
    expect(deviceKitChromeForScreen(chrome, undefined)).toBe(chrome);
    const legacy = chromeFixture();
    expect(deviceKitChromeForScreen(legacy, 3)).toBe(legacy);
  });
});

describe("deviceKitScreenRadius", () => {
  test("rotates asymmetric corners and their percentage axes with the display", () => {
    const chrome = {
      ...chromeFixture(),
      screen: { x: 40, y: 80, width: 200, height: 400 },
      screenCornerRadii: { topLeft: 10, topRight: 20, bottomRight: 30, bottomLeft: 40 },
    };

    expect(deviceKitScreenRadius(chrome, "landscape_left")).toBe("10% 2.5% 5% 7.5% / 20% 5% 10% 15%");
    expect(deviceKitScreenRadius(chrome, "landscape_right")).toBe("5% 7.5% 10% 2.5% / 10% 15% 20% 5%");
    expect(deviceKitScreenRadius(chrome, "portrait_upside_down")).toBe("15% 20% 5% 10% / 7.5% 10% 2.5% 5%");
    expect(deviceKitScreenRadius(chrome, "portrait")).toBe("5% 10% 15% 20% / 2.5% 5% 7.5% 10%");
  });

  test("preserves each corner in clockwise CSS order", () => {
    const chrome = {
      ...chromeFixture(),
      screen: { x: 40, y: 80, width: 200, height: 400 },
      screenCornerRadii: { topLeft: 10, topRight: 20, bottomRight: 30, bottomLeft: 0 },
    };

    expect(deviceKitScreenRadius(chrome)).toBe("5% 10% 15% 0% / 2.5% 5% 7.5% 0%");
  });

  test("keeps clipping proportional as the rendered screen scales", () => {
    const chrome: DeviceKitChromeDescriptor = {
      ...chromeFixture(),
      frame: { width: 200, height: 400 },
      screen: { x: 0, y: 0, width: 200, height: 400 },
      compositeImage: null,
      screenCornerRadii: { topLeft: 10, topRight: 20, bottomRight: 30, bottomLeft: 0 },
    };

    for (const containerSize of [{ width: 100, height: 200 }, { width: 200, height: 400 }]) {
      const markup = renderToStaticMarkup(createElement(DeviceKitChrome, { chrome, containerSize }));

      expect(markup).toContain(`width:${containerSize.width}px;height:${containerSize.height}px`);
      expect(markup).toContain("border-radius:5% 10% 15% 0% / 2.5% 5% 7.5% 0%");
    }
  });

  test("retains the scalar CSS format for legacy descriptors", () => {
    const chrome = {
      ...chromeFixture(),
      screen: { x: 40, y: 80, width: 200, height: 400 },
    };

    expect(deviceKitScreenRadius(chrome)).toBe("5% / 2.5%");
    expect(deviceKitScreenRadius(chrome, "landscape_left")).toBe("2.5% / 5%");
    expect(deviceKitScreenRadius(chrome, "landscape_right")).toBe("2.5% / 5%");
    expect(deviceKitScreenRadius(chrome, "portrait_upside_down")).toBe("5% / 2.5%");
  });
});

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
