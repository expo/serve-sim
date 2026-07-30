import { describe, expect, it } from "bun:test";

import { createCaptureSessionCache } from "../capture-session";
import { CaptureStore } from "../capture-store";
import { type CaptureProxy } from "../mitm-engine";

const UDID = "ABCD1234-0000-0000-0000-0000000000EF";
const BUNDLE_ID = "com.example.app";
const CA_PEM = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n";

/**
 * A session cache with every external effect recorded rather than performed. Nothing here touches a
 * simulator, a certificate store, or a process.
 */
function harness(
  overrides: {
    startProxy?: () => Promise<CaptureProxy>;
    trustCa?: (udid: string, caPem: string) => Promise<void>;
    attach?: (udid: string, bundleId: string, port: number) => Promise<void>;
    targetApp?: () => Promise<string | null>;
    teardownGraceMs?: number;
  } = {},
) {
  const calls: string[] = [];
  const cache = createCaptureSessionCache({
    startProxy:
      overrides.startProxy ??
      (async () => {
        calls.push("proxy-started");
        return {
          address: "127.0.0.1:9123",
          caPem: async () => CA_PEM,
          close: async () => void calls.push("proxy-closed"),
        };
      }),
    trustCa:
      overrides.trustCa ??
      (async (_udid, pem) => void calls.push(`trusted:${pem === CA_PEM ? "ok" : "wrong-pem"}`)),
    targetApp: overrides.targetApp ?? (async () => BUNDLE_ID),
    teardownGraceMs: overrides.teardownGraceMs ?? 0,
    attach:
      overrides.attach ??
      (async (_udid, bundleId, port) => void calls.push(`attached:${bundleId}:${port}`)),
  });
  return { cache, calls };
}

describe("capture session", () => {
  it("starts the proxy, trusts the CA, then relaunches the app pointed at it", async () => {
    const { cache, calls } = harness();
    const subscription = cache.subscribe(UDID, () => {});
    const meta = await cache.whenReady(UDID);

    expect(meta?.attachment).toBe("attached");
    expect(meta?.proxyAddress).toBe("127.0.0.1:9123");
    expect(meta?.attachError).toBeNull();
    // Order matters: an app relaunched before the CA is trusted fails every HTTPS handshake.
    expect(calls).toEqual(["proxy-started", "trusted:ok", `attached:${BUNDLE_ID}:9123`]);
    subscription.unsubscribe();
  });

  it("stops the proxy and deliberately leaves both the app and the certificate alone", async () => {
    const { cache, calls } = harness();
    const subscription = cache.subscribe(UDID, () => {});
    await cache.whenReady(UDID);
    calls.length = 0;

    subscription.unsubscribe();
    await Bun.sleep(10);

    // No relaunch, and no keychain reset: simctl cannot remove one root without wiping the whole
    // keychain, and the certificate is inert once the proxy's confdir takes its private key with it.
    expect(calls).toEqual(["proxy-closed"]);
  });

  it("reports a trust failure instead of relaunching the app into a proxy it will refuse", async () => {
    const { cache, calls } = harness({
      trustCa: async () => {
        throw new Error("simctl refused");
      },
    });
    cache.subscribe(UDID, () => {});
    const meta = await cache.whenReady(UDID);

    expect(meta?.attachment).toBe("failed");
    expect(meta?.attachError).toContain("simctl refused");
    expect(calls).not.toContain(`attached:${BUNDLE_ID}:9123`);
  });

  it("explains an empty capture when no app is in the foreground", async () => {
    const { cache, calls } = harness({ targetApp: async () => null });
    cache.subscribe(UDID, () => {});
    const meta = await cache.whenReady(UDID);

    expect(meta?.attachment).toBe("no-target");
    expect(meta?.attachError).toContain("No app of yours is in the foreground");
    // The address is still offered, so a developer can point something at it by hand.
    expect(meta?.proxyAddress).toBe("127.0.0.1:9123");
    expect(calls).not.toContain(`attached:${BUNDLE_ID}:9123`);
  });

  it("surfaces a relaunch failure rather than claiming capture is running", async () => {
    const { cache } = harness({
      attach: async () => {
        throw new Error("dist/simnet is missing");
      },
    });
    cache.subscribe(UDID, () => {});
    const meta = await cache.whenReady(UDID);

    expect(meta?.attachment).toBe("failed");
    expect(meta?.attachError).toContain("dist/simnet is missing");
  });

  it("surfaces a proxy that never started, rather than waiting on it forever", async () => {
    const { cache } = harness({
      startProxy: async () => {
        throw new Error("whistle exited before listening");
      },
    });
    cache.subscribe(UDID, () => {});
    const meta = await cache.whenReady(UDID);

    expect(meta?.attachment).toBe("failed");
    expect(meta?.attachError).toContain("whistle exited before listening");
    expect(meta?.proxyAddress).toBeNull();
  });

  it("shares one session between viewers and tears down only after the last leaves", async () => {
    const { cache, calls } = harness();
    const first = cache.subscribe(UDID, () => {});
    const second = cache.subscribe(UDID, () => {});
    await cache.whenReady(UDID);
    expect(calls.filter((call) => call === "proxy-started")).toHaveLength(1);

    first.unsubscribe();
    await Bun.sleep(10);
    expect(calls).not.toContain("proxy-closed");

    second.unsubscribe();
    await Bun.sleep(10);
    expect(calls).toContain("proxy-closed");
  });

  it("does not tear down a newer session when a stale unsubscribe fires", async () => {
    const { cache, calls } = harness();
    const stale = cache.subscribe(UDID, () => {});
    await cache.whenReady(UDID);
    stale.unsubscribe();
    await Bun.sleep(10);

    const fresh = cache.subscribe(UDID, () => {});
    await cache.whenReady(UDID);
    calls.length = 0;
    stale.unsubscribe(); // double-called; must not touch the session `fresh` created
    await Bun.sleep(10);

    expect(calls).toEqual([]);
    fresh.unsubscribe();
  });

  it("exposes the live store only while a session exists", async () => {
    const { cache } = harness();
    expect(cache.storeFor(UDID)).toBeNull();
    const subscription = cache.subscribe(UDID, () => {});
    expect(cache.storeFor(UDID)).toBeInstanceOf(CaptureStore);
    await cache.whenReady(UDID);
    subscription.unsubscribe();
    // Teardown runs on a timer even at a zero grace period, so the store outlives the call by a tick.
    await Bun.sleep(10);
    expect(cache.storeFor(UDID)).toBeNull();
  });

  it("reports proxy throughput only once the app is actually routed through it", async () => {
    const notRouted = harness({ targetApp: async () => null });
    notRouted.cache.subscribe(UDID, () => {});
    await notRouted.cache.whenReady(UDID);
    // Null rather than a zeroed reading, so the sampler falls back to the host counters instead of
    // reporting the app as idle.
    expect(notRouted.cache.throughputFor(UDID)).toBeNull();

    const routed = harness();
    routed.cache.subscribe(UDID, () => {});
    await routed.cache.whenReady(UDID);
    routed.cache.storeFor(UDID)!.noteTraffic(1500, 200);
    expect(routed.cache.throughputFor(UDID)).toEqual({ in: 1500, out: 200 });
  });

  it("reports a proxy that dies mid-session, and says the app needs relaunching", async () => {
    let killProxy: (reason: string) => void = () => {};
    const frames: string[] = [];
    const cache = createCaptureSessionCache({
      startProxy: async (_store, _udid, onUnexpectedExit) => {
        killProxy = onUnexpectedExit;
        return { address: "127.0.0.1:9123", caPem: async () => CA_PEM, close: async () => {} };
      },
      trustCa: async () => {},
      targetApp: async () => BUNDLE_ID,
      teardownGraceMs: 0,
      attach: async () => {},
    });
    cache.subscribe(UDID, (event) => frames.push(event.type));
    expect((await cache.whenReady(UDID))?.attachment).toBe("attached");

    killProxy("The capture proxy stopped unexpectedly (exit 1).");

    const meta = await cache.whenReady(UDID);
    expect(meta?.attachment).toBe("failed");
    expect(meta?.attachError).toContain("stopped unexpectedly");
    // The developer has to relaunch the app, so the reason has to say so.
    expect(meta?.attachError).toContain("relaunch");
    // And every viewer is told, rather than only the next one to subscribe.
    expect(frames).toContain("meta");
  });

  it("has no session state for a device that was never subscribed", async () => {
    const { cache } = harness();
    expect(await cache.whenReady(UDID)).toBeNull();
    expect(cache.throughputFor(UDID)).toBeNull();
  });
});
