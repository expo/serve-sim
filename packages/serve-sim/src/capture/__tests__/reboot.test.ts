import { describe, expect, test } from "bun:test";

import { rebootWithCapture } from "../reboot";
import { createCaptureRuntime } from "../runtime";
import { type CaptureProxy } from "../mitm-engine";

const UDID = "ABCD1234-0000-0000-0000-0000000000EF";
const CA_PEM = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n";

function harness() {
  const calls: string[] = [];
  const runtime = createCaptureRuntime({
    startProxy: async () => {
      calls.push("proxy-started");
      return {
        address: "127.0.0.1:9123",
        portFile: "/tmp/fake-confdir/proxy-port",
        caPem: async () => CA_PEM,
        close: async () => void calls.push("proxy-closed"),
      } as CaptureProxy;
    },
    trustCa: async () => void calls.push("trusted"),
    inject: async () => void calls.push("injected"),
    clearInjection: async () => void calls.push("injection-cleared"),
  });
  const deps = {
    runtime,
    shutdown: async (_udid: string) => void calls.push("device-shutdown"),
    boot: async (_udid: string) => void calls.push("device-booted"),
  };
  return { runtime, deps, calls };
}

describe("rebootWithCapture", () => {
  test("reboots and comes back capturing", async () => {
    const { deps, calls } = harness();

    const meta = await rebootWithCapture(UDID, /* enabled */ true, deps);

    expect(meta.attachment).toBe("capturing");
    // The injection has to be applied to the boot that will run the apps, so it comes after the reboot.
    expect(calls).toEqual([
      "device-shutdown",
      "device-booted",
      "proxy-started",
      "trusted",
      "injected",
    ]);
  });

  test("tears the old session down before the device restarts", async () => {
    const { runtime, deps, calls } = harness();
    await runtime.enableForDevice(UDID);
    calls.length = 0;

    await rebootWithCapture(UDID, /* enabled */ true, deps);

    // Leaving the previous injection set would point the new boot's apps at a dead port.
    expect(calls.indexOf("injection-cleared")).toBeLessThan(calls.indexOf("device-shutdown"));
    expect(calls.indexOf("proxy-closed")).toBeLessThan(calls.indexOf("device-booted"));
  });

  test("reboots into a clean device when capture is turned off", async () => {
    const { runtime, deps, calls } = harness();
    await runtime.enableForDevice(UDID);
    calls.length = 0;

    const meta = await rebootWithCapture(UDID, /* enabled */ false, deps);

    expect(meta.attachment).toBe("not-enabled");
    expect(calls).not.toContain("injected");
    expect(runtime.storeFor(UDID)).toBeNull();
  });

  test("joins a reboot already running instead of starting a competing one", async () => {
    const { deps, calls } = harness();
    let releaseBoot = () => {};
    const slowBoot = new Promise<void>((resolve) => {
      releaseBoot = resolve;
    });

    const first = rebootWithCapture(UDID, true, {
      ...deps,
      boot: async () => {
        calls.push("device-booted");
        await slowBoot;
      },
    });
    const second = rebootWithCapture(UDID, true, deps);
    releaseBoot();
    const [a, b] = await Promise.all([first, second]);

    // Interleaving a shutdown with a boot would leave the device in neither state.
    expect(calls.filter((call) => call === "device-shutdown")).toHaveLength(1);
    expect(calls.filter((call) => call === "device-booted")).toHaveLength(1);
    expect(a).toBe(b);
  });

  test("does not join an opposite-intent reboot; runs after it finishes", async () => {
    const { deps, calls } = harness();
    let releaseBoot = () => {};
    const slowBoot = new Promise<void>((resolve) => {
      releaseBoot = resolve;
    });

    const enable = rebootWithCapture(UDID, true, {
      ...deps,
      boot: async () => {
        calls.push("boot-enable");
        await slowBoot;
      },
    });
    // Opposite intent must not share the enable promise.
    const disablePromise = rebootWithCapture(UDID, false, {
      ...deps,
      boot: async () => {
        calls.push("boot-disable");
      },
    });
    releaseBoot();
    const [enabledMeta, disabledMeta] = await Promise.all([enable, disablePromise]);

    expect(enabledMeta.attachment).toBe("capturing");
    expect(disabledMeta.attachment).toBe("not-enabled");
    expect(calls.filter((call) => call === "boot-enable")).toHaveLength(1);
    expect(calls.filter((call) => call === "boot-disable")).toHaveLength(1);
  });

  test("reports a capture that could not start on the new boot", async () => {
    const { calls } = harness();
    const runtime = createCaptureRuntime({
      startProxy: async () => {
        throw new Error("mitmproxy is not installed");
      },
      trustCa: async () => {},
      inject: async () => {},
      clearInjection: async () => {},
    });

    const meta = await rebootWithCapture(UDID, /* enabled */ true, {
      runtime,
      shutdown: async () => void calls.push("device-shutdown"),
      boot: async () => void calls.push("device-booted"),
    });

    // The device did reboot; only capture failed, and the reason has to survive.
    expect(calls).toEqual(["device-shutdown", "device-booted"]);
    expect(meta.attachment).toBe("failed");
    expect(meta.attachError).toContain("mitmproxy is not installed");
  });
});
