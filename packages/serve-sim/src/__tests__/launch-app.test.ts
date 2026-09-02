import { describe, expect, test } from "bun:test";

import { launchAppAsync } from "../launch-app";

describe("launchAppAsync", () => {
  test("surfaces a simctl failure naming the device", async () => {
    await expect(
      launchAppAsync("NOT-A-DEVICE", { bundleId: "host.exp.Exponent", launchArgs: [] }),
    ).rejects.toThrow("NOT-A-DEVICE");
  });

  test("rejects an unopenable URL before it reaches the simulator", async () => {
    await expect(
      launchAppAsync("NOT-A-DEVICE", {
        bundleId: "host.exp.Exponent",
        launchArgs: [],
        openUrl: "exp://127.0.0.1:8081",
      }),
    ).rejects.toThrow("NOT-A-DEVICE");
  });
});
