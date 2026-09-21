import { expect, test } from "bun:test";
import { Quaternion, Vector3 } from "three";
import { HINGE_POSES } from "../hinge-control";
import { duoInitialView, duoPresetView, duoRotateView, duoViewFolds } from "../client/simulator/duo-view";

test("hinge motion never changes the saved view rotation for any preset", () => {
  for (const { id } of HINGE_POSES) {
    const view = duoPresetView(id);
    const rotation: typeof view.rotation = [...view.rotation];
    for (const angle of [0, 1, 30, 54, 55, 90, 150, 179, 180, 0]) {
      const fold = (180 - angle) * Math.PI / 360;
      const panels = duoViewFolds(fold, view);
      expect(panels.left - panels.right).toBeCloseTo(2 * fold, 10);
      expect(view.rotation).toEqual(rotation);
    }
  }
});

test("Laptop's base stays fixed and Tent's two edges stay level with a fixed view", () => {
  const laptop = duoPresetView("laptop");
  const tent = duoPresetView("tent");
  const direction = (point: Vector3, fold: number, rotation: number[]) => point
    .applyAxisAngle(new Vector3(0, 1, 0), fold).applyQuaternion(new Quaternion(...rotation));
  const baseNormal = new Vector3(0, Math.cos(Math.PI / 9), Math.sin(Math.PI / 9));
  const tableNormal = new Vector3(0, Math.cos(Math.PI / 18), Math.sin(Math.PI / 18));
  for (const angle of [0, 1, 30, 54, 55, 90, 150, 179, 180]) {
    const fold = (180 - angle) * Math.PI / 360;
    const base = duoViewFolds(fold, laptop);
    expect(direction(new Vector3(0, 0, 1), base.left, laptop.rotation).distanceTo(baseNormal)).toBeLessThan(1e-8);
    const feet = duoViewFolds(fold, tent);
    const left = direction(new Vector3(-1, 0, 0), feet.left, tent.rotation);
    const right = direction(new Vector3(1, 0, 0), feet.right, tent.rotation);
    expect(left.dot(tableNormal)).toBeCloseTo(right.dot(tableNormal), 8);
  }
});

test("Rotate turns the saved view even in tabletop modes and four clicks restore it", () => {
  for (const { id } of HINGE_POSES) {
    const initial = duoPresetView(id);
    for (const turns of [-1, 1]) {
      let view = duoRotateView(initial, turns);
      const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), turns * Math.PI / 2)
        .multiply(new Quaternion(...initial.rotation));
      expect(new Quaternion(...view.rotation).angleTo(expected)).toBeLessThan(1e-7);
      expect(view.fixedLeftFold).toBe(initial.fixedLeftFold);
      for (let click = 1; click < 4; click++) view = duoRotateView(view, turns);
      expect(new Quaternion(...view.rotation).angleTo(new Quaternion(...initial.rotation))).toBeLessThan(1e-7);
    }
  }
});

test("native orientation is used only to initialize a view; preset selection restores its own view", () => {
  const config = { screenId: 3, width: 2007, height: 2853, orientation: "portrait" as const };
  const portrait = duoInitialView(180, "open", config);
  const landscape = duoInitialView(180, "open", { ...config, orientation: "landscape_left" });
  expect(new Quaternion(...portrait.rotation).angleTo(new Quaternion(...landscape.rotation))).toBeCloseTo(Math.PI / 2, 8);
  expect(duoPresetView("open")).toEqual(landscape);
  expect(duoPresetView("closed")).not.toEqual(portrait);
});
