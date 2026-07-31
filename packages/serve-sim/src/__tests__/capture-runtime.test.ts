import { describe, expect, it } from "bun:test";

import { createCaptureRuntime } from "../capture-runtime";
import { CaptureStore } from "../capture-store";
import { type CaptureProxy } from "../mitm-engine";

const UDID = "ABCD1234-0000-0000-0000-0000000000EF";
const PORT_FILE = "/tmp/fake-confdir/proxy-port";
const CA_PEM = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n";

/** A runtime with every external effect recorded rather than performed. */
function harness(
  overrides: {
    startProxy?: (
      store: CaptureStore,
      onUnexpectedExit: (reason: string) => void,
    ) => Promise<CaptureProxy>;
    trustCa?: (udid: string, caPem: string) => Promise<void>;
    inject?: (udid: string, portFile: string) => Promise<void>;
    clearInjection?: (udid: string) => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const runtime = createCaptureRuntime({
    startProxy:
      overrides.startProxy ??
      (async () => {
        calls.push("proxy-started");
        return {
          address: "127.0.0.1:9123",
          portFile: "/tmp/fake-confdir/proxy-port",
          caPem: async () => CA_PEM,
          close: async () => void calls.push("proxy-closed"),
        };
      }),
    trustCa:
      overrides.trustCa ??
      (async (_udid, pem) => void calls.push(`trusted:${pem === CA_PEM ? "ok" : "wrong-pem"}`)),
    inject: overrides.inject ?? (async (_udid, portFile) => void calls.push(`injected:${portFile}`)),
    clearInjection: overrides.clearInjection ?? (async () => void calls.push("injection-cleared")),
  });
  return { runtime, calls };
}

describe("capture runtime", () => {
  it("starts the proxy, trusts the CA, then points the device at it", async () => {
    const { runtime, calls } = harness();
    const meta = await runtime.enableForDevice(UDID);

    expect(meta.attachment).toBe("capturing");
    expect(meta.proxyAddress).toBe("127.0.0.1:9123");
    expect(meta.intercepted).toBe(true);
    expect(meta.attachError).toBeNull();
    // Order matters: an app launched before the CA is trusted fails every HTTPS handshake.
    expect(calls).toEqual(["proxy-started", "trusted:ok", `injected:${PORT_FILE}`]);
  });

  it("reports a device that was never enabled, rather than inventing a session", () => {
    const { runtime } = harness();
    const meta = runtime.metaFor(UDID);

    expect(meta.attachment).toBe("not-enabled");
    expect(meta.intercepted).toBe(false);
    expect(meta.attachError).toContain("reboot");
    expect(runtime.storeFor(UDID)).toBeNull();
    expect(runtime.throughputFor(UDID)).toBeNull();
  });

  it("enables a device once, however many times it is asked", async () => {
    const { runtime, calls } = harness();
    await runtime.enableForDevice(UDID);
    await runtime.enableForDevice(UDID);

    expect(calls.filter((call) => call === "proxy-started")).toHaveLength(1);
  });

  it("reports a trust failure instead of claiming the device is capturing", async () => {
    const { runtime, calls } = harness({
      trustCa: async () => {
        throw new Error("simctl refused");
      },
    });
    const meta = await runtime.enableForDevice(UDID);

    expect(meta.attachment).toBe("failed");
    expect(meta.attachError).toContain("simctl refused");
    expect(meta.intercepted).toBe(false);
    // Nothing was pointed at a proxy the device would refuse.
    expect(calls).not.toContain(`injected:${PORT_FILE}`);
  });

  it("reports a proxy that never started, rather than throwing at the boot path", async () => {
    const { runtime } = harness({
      startProxy: async () => {
        throw new Error("mitmproxy is not installed");
      },
    });
    // Does not reject: a developer whose capture failed still wants a working simulator.
    const meta = await runtime.enableForDevice(UDID);

    expect(meta.attachment).toBe("failed");
    expect(meta.attachError).toContain("mitmproxy is not installed");
    expect(meta.proxyAddress).toBeNull();
  });

  it("reports an injection failure with the reason", async () => {
    const { runtime } = harness({
      inject: async () => {
        throw new Error("dist/simnet is missing");
      },
    });
    const meta = await runtime.enableForDevice(UDID);

    expect(meta.attachment).toBe("failed");
    expect(meta.attachError).toContain("dist/simnet is missing");
  });

  it("clears the injection before closing the proxy", async () => {
    const { runtime, calls } = harness();
    await runtime.enableForDevice(UDID);
    calls.length = 0;

    await runtime.disableForDevice(UDID);

    // A proxy that outlives the injection wastes a port; an injection that outlives the proxy points every
    // new launch at a dead one.
    expect(calls).toEqual(["injection-cleared", "proxy-closed"]);
    expect(runtime.storeFor(UDID)).toBeNull();
  });

  it("survives a teardown where clearing the injection fails", async () => {
    const { runtime, calls } = harness({
      clearInjection: async () => {
        throw new Error("device already shut down");
      },
    });
    await runtime.enableForDevice(UDID);

    await runtime.disableForDevice(UDID);

    // The proxy still has to go, or the port and the CA key leak.
    expect(calls).toContain("proxy-closed");
  });

  it("stops every device on shutdown", async () => {
    const { runtime, calls } = harness();
    await runtime.enableForDevice(UDID);
    await runtime.enableForDevice("SECOND-DEVICE");
    calls.length = 0;

    await runtime.disableAll();

    expect(calls.filter((call) => call === "proxy-closed")).toHaveLength(2);
    expect(runtime.storeFor(UDID)).toBeNull();
    expect(runtime.storeFor("SECOND-DEVICE")).toBeNull();
  });

  it("reports a proxy that dies mid-session, and says the apps need relaunching", async () => {
    let killProxy: (reason: string) => void = () => {};
    const frames: string[] = [];
    const { runtime } = harness({
      startProxy: async (_store, onUnexpectedExit) => {
        killProxy = onUnexpectedExit;
        return { address: "127.0.0.1:9123", portFile: "/tmp/fake-confdir/proxy-port", caPem: async () => CA_PEM, close: async () => {} };
      },
    });
    await runtime.enableForDevice(UDID);
    runtime.subscribe(UDID, (event) => frames.push(event.type));

    killProxy("The capture proxy stopped unexpectedly (exit 1).");

    const meta = runtime.metaFor(UDID);
    expect(meta.attachment).toBe("failed");
    expect(meta.intercepted).toBe(false);
    expect(meta.attachError).toContain("stopped unexpectedly");
    expect(meta.attachError).toContain("relaunch");
    // Every viewer is told, rather than only the next one to subscribe.
    expect(frames).toContain("meta");
  });

  it("reports proxy throughput only while the device is capturing", async () => {
    const failed = harness({
      trustCa: async () => {
        throw new Error("nope");
      },
    });
    await failed.runtime.enableForDevice(UDID);
    expect(failed.runtime.throughputFor(UDID)).toBeNull();

    const capturing = harness();
    await capturing.runtime.enableForDevice(UDID);
    capturing.runtime.storeFor(UDID)!.noteTraffic(1500, 200);
    expect(capturing.runtime.throughputFor(UDID)).toEqual({ in: 1500, out: 200 });
  });

  it("reads as starting, not as failed, while it is still coming up", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runtime } = harness({
      startProxy: async () => {
        await gate;
        return { address: "127.0.0.1:9123", portFile: "/tmp/fake-confdir/proxy-port", caPem: async () => CA_PEM, close: async () => {} };
      },
    });

    const pending = runtime.enableForDevice(UDID);
    // A viewer subscribing mid-reboot must not be told capture failed, with no reason to show.
    expect(runtime.metaFor(UDID).attachment).toBe("starting");
    expect(runtime.metaFor(UDID).attachError).toBeNull();

    release();
    expect((await pending).attachment).toBe("capturing");
  });

  it("stops every device even when disableAll is called detached from the runtime", async () => {
    const { runtime, calls } = harness();
    await runtime.enableForDevice(UDID);
    calls.length = 0;

    // Destructured on purpose: a `this`-bound implementation throws here.
    const { disableAll } = runtime;
    await disableAll();

    expect(calls).toContain("proxy-closed");
    expect(runtime.storeFor(UDID)).toBeNull();
  });

  it("hands a subscriber the live store without changing what the device does", async () => {
    const { runtime, calls } = harness();
    await runtime.enableForDevice(UDID);
    calls.length = 0;

    const events: string[] = [];
    const first = runtime.subscribe(UDID, (event) => events.push(event.type));
    const second = runtime.subscribe(UDID, () => {});
    runtime.storeFor(UDID)!.start("GET", "https://example.test/a");
    first.unsubscribe();
    second.unsubscribe();

    expect(events).toEqual(["started"]);
    // Subscribing and leaving is not a lifecycle event.
    expect(calls).toEqual([]);
    expect(runtime.metaFor(UDID).attachment).toBe("capturing");
  });
});
