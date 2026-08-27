import { describe, expect, test } from "bun:test";

import { createCaptureRuntime, CaptureEnableError } from "../runtime";
import { CaptureStore } from "../store";
import { type CaptureProxy, type MitmProxyDeps } from "../mitm-engine";

const UDID = "ABCD1234-0000-0000-0000-0000000000EF";
const PORT_FILE = "/tmp/fake-confdir/proxy-port";
const CA_PEM = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n";

/** A runtime with every external effect recorded rather than performed. */
function harness(
  overrides: {
    startProxy?: (store: CaptureStore, deps: MitmProxyDeps) => Promise<CaptureProxy>;
    trustCa?: (udid: string, caPem: string) => Promise<void>;
    inject?: (udid: string, portFile: string) => Promise<void>;
    clearInjection?: (udid: string) => Promise<void>;
    injectionCleared?: (udid: string) => Promise<boolean>;
    isInjected?: (udid: string, portFile: string) => Promise<boolean>;
    checkIntervalMs?: number;
    writeDiskArtifacts?: boolean;
    captureDirFor?: (udid: string) => string;
    creatorVersion?: string;
    flushIntervalMs?: number;
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
    // Without this, teardown falls through to the real bootInjectionCleared and shells out to xcrun.
    injectionCleared: overrides.injectionCleared ?? (async () => true),
    isInjected: overrides.isInjected ?? (async () => true),
    checkIntervalMs: overrides.checkIntervalMs ?? 0,
    // Default off in unit tests — dedicated disk tests opt in with a temp dir.
    writeDiskArtifacts: overrides.writeDiskArtifacts ?? false,
    captureDirFor: overrides.captureDirFor,
    creatorVersion: overrides.creatorVersion,
    flushIntervalMs: overrides.flushIntervalMs,
  });
  return { runtime, calls };
}

describe("capture runtime", () => {
  test("starts the proxy, trusts the CA, then points the device at it", async () => {
    const { runtime, calls } = harness();
    const meta = await runtime.enableForDevice(UDID);

    expect(meta.attachment).toBe("capturing");
    expect(meta.proxyAddress).toBe("127.0.0.1:9123");
    expect(meta.attachError).toBeNull();
    expect(meta.fields).toEqual([]);
    // Order matters: an app launched before the CA is trusted fails every HTTPS handshake.
    expect(calls).toEqual(["proxy-started", "trusted:ok", `injected:${PORT_FILE}`]);
  });

  test("honors an explicit capture field allowlist on new sessions", async () => {
    const { runtime } = harness();
    runtime.setFields(["header", "request-body", "response-body"]);
    const meta = await runtime.enableForDevice(UDID);
    expect(meta.fields).toEqual(["header", "request-body", "response-body"]);
  });

  test("reports a device that was never enabled, rather than inventing a session", () => {
    const { runtime } = harness();
    const meta = runtime.metaFor(UDID);

    expect(meta.attachment).toBe("not-enabled");
    expect(meta.attachError).toContain("reboot");
    expect(meta.fields).toEqual([]);
    expect(runtime.storeFor(UDID)).toBeNull();
    expect(runtime.throughputFor(UDID)).toBeNull();
  });

  test("enables a device once, however many times it is asked", async () => {
    const { runtime, calls } = harness();
    await runtime.enableForDevice(UDID);
    await runtime.enableForDevice(UDID);

    expect(calls.filter((call) => call === "proxy-started")).toHaveLength(1);
  });

  test("reports a trust failure instead of claiming the device is capturing", async () => {
    const { runtime, calls } = harness({
      trustCa: async () => {
        throw new Error("simctl refused");
      },
    });
    const err = await runtime.enableForDevice(UDID).catch((e) => e);

    expect(err).toBeInstanceOf(CaptureEnableError);
    expect(err.meta.attachment).toBe("failed");
    expect(err.meta.attachError).toContain("simctl refused");
    // Nothing was pointed at a proxy the device would refuse.
    expect(calls).not.toContain(`injected:${PORT_FILE}`);
    // Proxy must not keep running after a failed enable, or retries / ports leak.
    expect(calls).toContain("proxy-closed");
    expect(calls).toContain("injection-cleared");
  });

  test("retries enable after a prior failure", async () => {
    let failTrust = true;
    const { runtime, calls } = harness({
      trustCa: async () => {
        if (failTrust) throw new Error("simctl refused");
      },
    });
    await expect(runtime.enableForDevice(UDID)).rejects.toBeInstanceOf(CaptureEnableError);
    expect(runtime.metaFor(UDID).attachment).toBe("failed");

    failTrust = false;
    calls.length = 0;
    const meta = await runtime.enableForDevice(UDID);

    expect(meta.attachment).toBe("capturing");
    expect(calls).toContain("proxy-started");
    expect(calls).toContain(`injected:${PORT_FILE}`);
  });

  test("rejects when the proxy never starts, after publishing failed meta", async () => {
    const { runtime } = harness({
      startProxy: async () => {
        throw new Error("mitmproxy is not installed");
      },
    });
    const err = await runtime.enableForDevice(UDID).catch((e) => e);

    expect(err).toBeInstanceOf(CaptureEnableError);
    expect(err.meta.attachment).toBe("failed");
    expect(err.meta.attachError).toContain("mitmproxy is not installed");
    expect(err.meta.proxyAddress).toBeNull();
  });

  test("reports an injection failure with the reason", async () => {
    const { runtime, calls } = harness({
      inject: async () => {
        throw new Error("dist/simnet is missing");
      },
    });
    const err = await runtime.enableForDevice(UDID).catch((e) => e);

    expect(err).toBeInstanceOf(CaptureEnableError);
    expect(err.meta.attachment).toBe("failed");
    expect(err.meta.attachError).toContain("dist/simnet is missing");
    expect(calls).toContain("injection-cleared");
    expect(calls).toContain("proxy-closed");
  });

  test("publishes meta when enable finishes so SSE clients leave starting", async () => {
    const { runtime } = harness();
    const seen: string[] = [];
    const pending = runtime.enableForDevice(UDID);
    const { meta, unsubscribe } = runtime.subscribe(UDID, (event) => {
      if (event.type === "meta") seen.push(event.meta.attachment);
    });
    expect(meta.attachment).toBe("starting");
    await pending;
    unsubscribe();
    expect(seen).toContain("capturing");
  });

  test("clears the injection before closing the proxy", async () => {
    const { runtime, calls } = harness();
    await runtime.enableForDevice(UDID);
    calls.length = 0;

    await runtime.disableForDevice(UDID);

    // A proxy that outlives the injection wastes a port; an injection that outlives the proxy points every
    // new launch at a dead one.
    expect(calls).toEqual(["injection-cleared", "proxy-closed"]);
    expect(runtime.storeFor(UDID)).toBeNull();
  });

  test("survives a teardown where clearing the injection fails", async () => {
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

  test("stops every device on shutdown", async () => {
    const { runtime, calls } = harness();
    await runtime.enableForDevice(UDID);
    await runtime.enableForDevice("SECOND-DEVICE");
    calls.length = 0;

    await runtime.disableAll();

    expect(calls.filter((call) => call === "proxy-closed")).toHaveLength(2);
    expect(runtime.storeFor(UDID)).toBeNull();
    expect(runtime.storeFor("SECOND-DEVICE")).toBeNull();
  });

  test("reports a proxy that dies mid-session, and says the apps need relaunching", async () => {
    let killProxy: (reason: string) => void = () => {};
    const frames: string[] = [];
    const { runtime } = harness({
      startProxy: async (_store, deps) => {
        killProxy = deps.onUnexpectedExit ?? (() => {});
        return { address: "127.0.0.1:9123", portFile: "/tmp/fake-confdir/proxy-port", caPem: async () => CA_PEM, close: async () => {} };
      },
    });
    await runtime.enableForDevice(UDID);
    runtime.subscribe(UDID, (event) => frames.push(event.type));

    killProxy("The capture proxy stopped unexpectedly (exit 1).");

    const meta = runtime.metaFor(UDID);
    expect(meta.attachment).toBe("failed");
    expect(meta.attachError).toContain("stopped unexpectedly");
    expect(meta.attachError).toContain("relaunch");
    // Every viewer is told, rather than only the next one to subscribe.
    expect(frames).toContain("meta");
  });

  test("counts oversized control bodies onto meta for the UI and logs", async () => {
    let reportOversized: NonNullable<MitmProxyDeps["onOversizedControlBody"]> = () => {};
    const frames: Array<{ type: string; meta?: { droppedOversizedBodies?: number } }> = [];
    const { runtime } = harness({
      startProxy: async (_store, deps) => {
        reportOversized = deps.onOversizedControlBody ?? (() => {});
        return {
          address: "127.0.0.1:9123",
          portFile: "/tmp/fake-confdir/proxy-port",
          caPem: async () => CA_PEM,
          close: async () => {},
        };
      },
    });
    await runtime.enableForDevice(UDID);
    runtime.subscribe(UDID, (event) => {
      if (event.type === "meta") frames.push(event);
    });

    reportOversized({ bytesSeen: 11_000_000, limit: 10_485_760, path: "/response" });
    reportOversized({ bytesSeen: 12_000_000, limit: 10_485_760, path: "/response" });

    expect(runtime.metaFor(UDID).droppedOversizedBodies).toBe(2);
    expect(frames.at(-1)?.meta?.droppedOversizedBodies).toBe(2);
  });

  test("reports proxy throughput only while the device is capturing", async () => {
    const failed = harness({
      trustCa: async () => {
        throw new Error("nope");
      },
    });
    await expect(failed.runtime.enableForDevice(UDID)).rejects.toBeInstanceOf(CaptureEnableError);
    expect(failed.runtime.throughputFor(UDID)).toBeNull();

    const capturing = harness();
    await capturing.runtime.enableForDevice(UDID);
    const capturingStore = capturing.runtime.storeFor(UDID);
    if (!capturingStore) throw new Error("expected capture store");
    capturingStore.noteTraffic(1500, 200);
    expect(capturing.runtime.throughputFor(UDID)).toEqual({ netInBytesPerSec: 1500, netOutBytesPerSec: 200 });
  });

  test("reads as starting, not as failed, while it is still coming up", async () => {
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


  test("reports a device that quietly stopped capturing after consecutive misses", async () => {
    const { runtime } = harness({ isInjected: async () => false, checkIntervalMs: 0 });
    const frames: string[] = [];
    await runtime.enableForDevice(UDID);
    runtime.subscribe(UDID, (event) => frames.push(event.type));

    // One miss is treated as a transient probe failure.
    expect((await runtime.refreshForDevice(UDID)).attachment).toBe("capturing");
    const meta = await runtime.refreshForDevice(UDID);

    expect(meta.attachment).toBe("failed");
    expect(meta.attachError).toContain("restarted");
    expect(frames).toContain("meta");
  });

  test("asks the device once when several viewers check at the same moment", async () => {
    let asks = 0;
    const { runtime } = harness({
      isInjected: async () => {
        asks++;
        return true;
      },
    });
    await runtime.enableForDevice(UDID);

    await Promise.all([
      runtime.refreshForDevice(UDID),
      runtime.refreshForDevice(UDID),
      runtime.refreshForDevice(UDID),
    ]);

    expect(asks).toBe(1);
  });

  test("does not ask again straight away, however often it is called", async () => {
    let asks = 0;
    const { runtime } = harness({
      checkIntervalMs: 60_000,
      isInjected: async () => {
        asks++;
        return true;
      },
    });
    await runtime.enableForDevice(UDID);

    await runtime.refreshForDevice(UDID);
    await runtime.refreshForDevice(UDID);

    expect(asks).toBe(1);
  });

  test("leaves a healthy device alone and tells nobody", async () => {
    const { runtime } = harness();
    const frames: string[] = [];
    await runtime.enableForDevice(UDID);
    runtime.subscribe(UDID, (event) => frames.push(event.type));

    expect((await runtime.refreshForDevice(UDID)).attachment).toBe("capturing");
    expect(frames).toEqual([]);
  });

  test("keeps an existing failure reason rather than replacing it with a vaguer one", async () => {
    const { runtime } = harness({
      trustCa: async () => {
        throw new Error("simctl refused");
      },
      isInjected: async () => false,
    });
    await expect(runtime.enableForDevice(UDID)).rejects.toBeInstanceOf(CaptureEnableError);

    expect((await runtime.refreshForDevice(UDID)).attachError).toContain("simctl refused");
  });

  test("reports a device it never enabled as not enabled, without asking the device", async () => {
    let asked = false;
    const { runtime } = harness({
      isInjected: async () => {
        asked = true;
        return true;
      },
    });

    expect((await runtime.refreshForDevice(UDID)).attachment).toBe("not-enabled");
    expect(asked).toBe(false);
  });

  test("does not treat a probe error as an injection miss", async () => {
    const { runtime } = harness({
      checkIntervalMs: 0,
      isInjected: async () => {
        throw new Error("device not found");
      },
    });
    await runtime.enableForDevice(UDID);

    expect((await runtime.refreshForDevice(UDID)).attachment).toBe("capturing");
    expect((await runtime.refreshForDevice(UDID)).attachment).toBe("capturing");
  });

  test("hands a subscriber the live store without changing what the device does", async () => {
    const { runtime, calls } = harness();
    await runtime.enableForDevice(UDID);
    calls.length = 0;

    const events: string[] = [];
    const first = runtime.subscribe(UDID, (event) => events.push(event.type));
    const second = runtime.subscribe(UDID, () => {});
    const store = runtime.storeFor(UDID);
    if (!store) throw new Error("expected capture store");
    store.start("GET", "https://example.test/a");
    first.unsubscribe();
    second.unsubscribe();

    expect(events).toEqual(["started"]);
    // Subscribing and leaving is not a lifecycle event.
    expect(calls).toEqual([]);
    expect(runtime.metaFor(UDID).attachment).toBe("capturing");
  });

  test("says so when teardown left the device injected", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: unknown) => void errors.push(String(message));
    try {
      const { runtime } = harness({ injectionCleared: async () => false });
      await runtime.enableForDevice(UDID);
      await runtime.disableForDevice(UDID);
    } finally {
      console.error = original;
    }

    expect(errors.join("\n")).toContain("still has the capture library injected");
  });

  test("writes network-capture.json + capture.har while capturing, then removes them on disable", async () => {
    const { existsSync, mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-runtime-disk-"));
    const { runtime } = harness({
      writeDiskArtifacts: true,
      captureDirFor: () => dir,
      creatorVersion: "disk-test",
      // HAR is stream-rebuilt on an interval from NDJSON, not on every finish.
      flushIntervalMs: 50,
    });

    try {
      await runtime.enableForDevice(UDID);
      const paths = runtime.artifactPathsFor(UDID);
      expect(paths?.networkCapturePath).toContain("network-capture.json");
      expect(paths?.harPath).toContain("capture.har");

      const store = runtime.storeFor(UDID);
      if (!store) throw new Error("expected capture store");
      const id = store.start("GET", "https://example.test/");
      store.setBody(id, {
        requestHeaders: {},
        responseHeaders: {},
        requestBody: null,
        responseBody: "hi",
        requestTruncated: false,
        responseTruncated: false,
        requestBinary: false,
        responseBinary: false,
      });
      store.update(id, { status: 200, durationMs: 3, responseBytes: 2 }, true);

      // NDJSON append is async; HAR rebuild is interval/flush. Wait for both.
      const eventsPath = join(dir, "network-capture.json");
      const harPath = join(dir, "capture.har");
      const deadline = Date.now() + 2000;
      let har: { log: { entries: Array<{ response: { content: { text?: string } } }> } } | null =
        null;
      while (Date.now() < deadline) {
        const eventsReady =
          existsSync(eventsPath) && readFileSync(eventsPath, "utf8").includes('"type":"finished"');
        if (eventsReady && existsSync(harPath)) {
          try {
            const parsed = JSON.parse(readFileSync(harPath, "utf8"));
            if (parsed.log?.entries?.length === 1) {
              har = parsed;
              break;
            }
          } catch {
            // HAR not flushed yet (interval rebuild).
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const events = readFileSync(eventsPath, "utf8");
      expect(events).toContain('"type":"finished"');
      if (har === null) throw new Error("expected capture.har with one entry");
      expect(har.log.entries).toHaveLength(1);
      const [entry] = har.log.entries;
      if (entry === undefined) throw new Error("expected first HAR entry");
      expect(entry.response.content.text).toBe("hi");

      await runtime.disableForDevice(UDID);
      expect(runtime.artifactPathsFor(UDID)).toBeNull();
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removes capture artifacts when enable fails after disk attach", async () => {
    const { existsSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-runtime-disk-fail-"));
    const { runtime } = harness({
      writeDiskArtifacts: true,
      captureDirFor: () => dir,
      trustCa: async () => {
        throw new Error("ca failed");
      },
    });

    try {
      await expect(runtime.enableForDevice(UDID)).rejects.toMatchObject({
        name: "CaptureEnableError",
        meta: { attachment: "failed" },
      });
      expect(runtime.artifactPathsFor(UDID)).toBeNull();
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses one policy for every device, however capture was started", async () => {
    // The policy used to be a per-call argument and two of three enable paths forgot it, so a panel
    // reboot silently narrowed capture to metadata with nothing said.
    const seen: (readonly string[])[] = [];
    const runtime = createCaptureRuntime({
      startProxy: async (_store, deps) => {
        seen.push([...(deps.fields ?? [])]);
        return {
          address: "127.0.0.1:9123",
          portFile: PORT_FILE,
          caPem: async () => CA_PEM,
          close: async () => {},
        };
      },
      trustCa: async () => {},
      inject: async () => {},
      clearInjection: async () => {},
      injectionCleared: async () => true,
    });
    runtime.setFields(["header"]);

    await runtime.enableForDevice(UDID);
    await runtime.disableForDevice(UDID);
    await runtime.enableForDevice(UDID);

    expect(seen).toEqual([["header"], ["header"]]);
  });
});
