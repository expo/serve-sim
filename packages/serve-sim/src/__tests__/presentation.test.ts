import { describe, expect, test } from "bun:test";
import { applyFullscreenSearch, presentationModeFromSearch } from "../client/utils/presentation";

describe("presentationModeFromSearch", () => {
  test("is off by default", () => {
    expect(presentationModeFromSearch("")).toEqual({ initial: false, embedLocked: false });
    expect(presentationModeFromSearch("?device=udid")).toEqual({ initial: false, embedLocked: false });
  });

  test("enters presentation from fullscreen=1", () => {
    expect(presentationModeFromSearch("?fullscreen=1")).toEqual({
      initial: true,
      embedLocked: false,
    });
  });

  test("ignores fullscreen=true", () => {
    expect(presentationModeFromSearch("?fullscreen=true")).toEqual({
      initial: false,
      embedLocked: false,
    });
  });

  test("locks presentation for embed=1", () => {
    expect(presentationModeFromSearch("?embed=1&device=udid")).toEqual({
      initial: true,
      embedLocked: true,
    });
  });
});

describe("applyFullscreenSearch", () => {
  test("sets and clears the fullscreen flag without dropping other params", () => {
    const withFlag = applyFullscreenSearch("https://sim.local/?device=udid", true);
    expect(withFlag).toContain("fullscreen=1");
    expect(withFlag).toContain("device=udid");

    const cleared = applyFullscreenSearch(withFlag, false);
    expect(cleared).not.toContain("fullscreen");
    expect(cleared).toContain("device=udid");
  });

  test("does not rewrite an embed URL", () => {
    const href = "https://sim.local/?embed=1&device=udid";
    expect(applyFullscreenSearch(href, false)).toBe(href);
    expect(applyFullscreenSearch(href, true)).toBe(href);
  });
});
