import { expect, test } from "bun:test";
import { Box3, Vector3 } from "three";
import { duoDeviceControlAnchors } from "../client/simulator/duo-device-controls";
import type { DeviceKitChromeButton } from "../client/utils/grid";
import { runChildSuite } from "./fixtures/run-child-suite";

const bounds = new Box3(new Vector3(-8, -6, 0), new Vector3(8, 6, 0));
const button = (name: string, x: number, y: number): DeviceKitChromeButton => ({
  name, frame: { x, y, width: 10, height: 10 }, hover: { x: 0, y: 0 },
  image: "", imageDown: null, onTop: false, usagePage: 12, usage: 48,
});

test("hardware controls map the native inner chrome to the right panel's top and outer edges", () => {
  const anchors = duoDeviceControlAnchors(bounds, {
    screen: { x: 20, y: 20, width: 600, height: 800 },
    buttons: [button("volume-up", 5, 135), button("volume-down", 5, 215), button("power", 225, 5)],
  });
  expect(anchors.volume.point.x).toBeCloseTo(4.8);
  expect(anchors.volume.point.y).toBeGreaterThan(bounds.max.y);
  expect(anchors.volume.normal.toArray()).toEqual([0, 1, 0]);
  expect(anchors.power.point.x).toBeGreaterThan(bounds.max.x);
  expect(anchors.power.point.y).toBeCloseTo(1.8);
  expect(anchors.power.normal.toArray()).toEqual([1, 0, 0]);
});

test("control anchors scale with the installed model", () => {
  const normal = duoDeviceControlAnchors(bounds);
  const larger = duoDeviceControlAnchors(new Box3(bounds.min.clone().multiplyScalar(2), bounds.max.clone().multiplyScalar(2)));
  for (const name of ["volume", "power"] as const) {
    expect(larger[name].point.distanceTo(normal[name].point.clone().multiplyScalar(2))).toBeLessThan(1e-8);
    expect(normal[name].point.x).toBeGreaterThan(0);
  }
  expect(normal.power.point.y).toBeGreaterThan(0);
});

test("device button presses and cleanup", async () => {
  const { exitCode, output } = await runChildSuite("duo-device-button.child.ts");
  expect(output).toContain("3 pass");
  expect(exitCode).toBe(0);
}, 10_000);
