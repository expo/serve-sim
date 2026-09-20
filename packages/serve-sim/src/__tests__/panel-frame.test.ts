import { expect, test } from "bun:test";
import { matchesPanelFrame } from "../client/simulator/panel-frame";

test("physical panel filtering accepts rotated and encoder-rounded frames without mixing LCDs", () => {
  const inner = 2007 / 2853, cover = 1398 / 2034;
  for (const [w, h] of [[2007, 2853], [2006, 2852], [2853, 2007], [2852, 2006], [1500, 2136]]) {
    expect(matchesPanelFrame(w!, h!, inner)).toBe(true);
    expect(matchesPanelFrame(w!, h!, cover)).toBe(false);
  }
  expect(matchesPanelFrame(1398, 2034, cover)).toBe(true);
  expect(matchesPanelFrame(2034, 1398, inner)).toBe(false);
  expect(matchesPanelFrame(800, 600)).toBe(true);
});
