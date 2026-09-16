import { describe, expect, it } from "bun:test";

import { describeDownscale } from "../client/components/stream-stats-labels";

const sender = (width: number, height: number, qualityLimitationReason: string | null) =>
  ({ width, height, qualityLimitationReason }) as Parameters<typeof describeDownscale>[1];

describe("describeDownscale", () => {
  it("names the size actually encoded and the size that was picked", () => {
    expect(describeDownscale(1600, sender(552, 1200, "bandwidth"))).toBe("1200 of 1600 (bitrate)");
  });

  it("blames the encoder when WebRTC says cpu", () => {
    expect(describeDownscale(1600, sender(552, 1200, "cpu"))).toBe("1200 of 1600 (encoder)");
  });

  /// A stream can be bitrate-limited with no packet loss, so the cause is never "network".
  it("does not name a cause WebRTC did not give", () => {
    expect(describeDownscale(1600, sender(552, 1200, "none"))).toBe("1200 of 1600");
    expect(describeDownscale(1600, sender(552, 1200, null))).toBe("1200 of 1600");
  });

  it("passes through an unknown reason rather than inventing one", () => {
    expect(describeDownscale(1600, sender(552, 1200, "other"))).toBe("1200 of 1600 (other)");
  });

  it("says nothing when the encode matches or exceeds the pick", () => {
    expect(describeDownscale(1600, sender(736, 1600, "none"))).toBeNull();
    expect(describeDownscale(1280, sender(1206, 2622, "none"))).toBeNull();
  });

  it("says nothing when no size was picked, so Full never reads as downscaled", () => {
    expect(describeDownscale(0, sender(552, 1200, "bandwidth"))).toBeNull();
  });

  it("says nothing before the first frame reports a size", () => {
    expect(describeDownscale(1600, sender(0, 0, "bandwidth"))).toBeNull();
    expect(describeDownscale(1600, { width: null, height: null, qualityLimitationReason: null })).toBeNull();
  });

  it("uses the long edge whichever way the device is held", () => {
    expect(describeDownscale(1600, sender(1200, 552, "bandwidth"))).toBe("1200 of 1600 (bitrate)");
  });
});
