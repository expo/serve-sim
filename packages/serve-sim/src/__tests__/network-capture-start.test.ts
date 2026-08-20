import { describe, expect, test } from "bun:test";

import {
  disableNetworkCaptureForStoppedDevice,
  enableNetworkCaptureForStartedDevice,
} from "../middleware";

describe("enableNetworkCaptureForStartedDevice", () => {
  test("does nothing when network capture is off", async () => {
    let called = false;
    await enableNetworkCaptureForStartedDevice("UDID", false, {
      enable: async () => {
        called = true;
        return { proxyAddress: "127.0.0.1:1" };
      },
    });
    expect(called).toBe(false);
  });

  test("enables capture and logs success for a device started from the sidebar", async () => {
    const logs: string[] = [];
    await enableNetworkCaptureForStartedDevice("UDID-1", true, {
      enable: async (udid) => {
        expect(udid).toBe("UDID-1");
        return { proxyAddress: "127.0.0.1:5555" };
      },
      log: (message) => logs.push(message),
      error: (message) => logs.push(`err:${message}`),
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Network capture on for UDID-1");
    expect(logs[0]).toContain("127.0.0.1:5555");
  });

  test("logs the attach error when enable fails", async () => {
    const errors: string[] = [];
    await enableNetworkCaptureForStartedDevice("UDID-2", true, {
      enable: async () => {
        throw new Error("mitmproxy is not installed");
      },
      log: () => {},
      error: (message) => errors.push(message),
    });
    expect(errors[0]).toContain("UDID-2");
    expect(errors[0]).toContain("mitmproxy is not installed");
  });
});

describe("disableNetworkCaptureForStoppedDevice", () => {
  test("does nothing when network capture is off", async () => {
    let called = false;
    await disableNetworkCaptureForStoppedDevice("UDID", false, {
      disable: async () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });

  test("disables capture when a captured device is shut down from the grid", async () => {
    const disabled: string[] = [];
    await disableNetworkCaptureForStoppedDevice("UDID-3", true, {
      disable: async (udid) => void disabled.push(udid),
    });
    expect(disabled).toEqual(["UDID-3"]);
  });
});
