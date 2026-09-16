import { describe, expect, test } from "bun:test";
import { maxDimensionOptions } from "../client/utils/stream-max-dimension-options";

const options = (maxDimension: number, configured = 0) =>
  maxDimensionOptions({ maxDimension }, configured).map((option) => option.value);

const ALL = ["0", "1920", "1600", "1280", "960", "720"];

describe("max size options", () => {
  test("offers every size, including Full, when nothing constrains the session", () => {
    expect(options(0)).toEqual(ALL);
  });

  test("offers Full once the session can negotiate a level that fits", () => {
    // H.264 was barred from Full because native killed the stream. That was the negotiated
    // level, not the resolution, and the encoder now holds whatever the peer negotiated.
    expect(options(1280)).toEqual(ALL);
  });

  test("caps the list at the size the session was configured with", () => {
    expect(options(960, 960)).toEqual(["960", "720"]);
    expect(options(1280, 1280)).toEqual(["1280", "960", "720"]);
  });

  test("lowering the size does not hide the sizes above it", () => {
    expect(options(720, 960)).toEqual(["960", "720"]);
    expect(options(720)).toEqual(ALL);
  });

  test("keeps the current value selectable so the picker never misreports the state", () => {
    expect(options(0)).toContain("0");
    expect(options(1600)).toContain("1600");
    expect(options(800, 960)).toContain("800");
    expect(options(1920, 1280)).toEqual(["1280", "960", "720", "1920"]);
  });
});
