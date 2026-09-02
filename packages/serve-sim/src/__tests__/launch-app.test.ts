import { describe, expect, test } from "bun:test";

import { launchAppAsync } from "../launch-app";

// These shell out to a real simctl against a device that cannot exist, so they
// assert only that the failure reaches the caller. simctl's own wording is not
// stable across hosts, and the call is slow enough on CI to need the headroom.
const SIMCTL_TIMEOUT_MS = 60_000;

describe("launchAppAsync", () => {
  test(
    "surfaces a failed launch naming the device",
    async () => {
      await expect(
        launchAppAsync("NOT-A-DEVICE", { bundleId: "host.exp.Exponent", launchArgs: [] }),
      ).rejects.toThrow("NOT-A-DEVICE");
    },
    SIMCTL_TIMEOUT_MS,
  );

  test(
    "does not open a URL when the launch failed",
    async () => {
      await expect(
        launchAppAsync("NOT-A-DEVICE", {
          bundleId: "host.exp.Exponent",
          launchArgs: [],
          openUrl: "exp://127.0.0.1:8081",
        }),
      ).rejects.toThrow("NOT-A-DEVICE");
    },
    SIMCTL_TIMEOUT_MS,
  );
});
