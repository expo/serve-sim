// Capture as a property of a booted device rather than of a viewer.
//
// A device booted with capture runs one proxy for its whole boot session and points every app it launches
// at it. Subscribing to the stream only starts reading what is already being recorded, so opening the panel
// cannot change what the device does — and an app's first request is captured, which is impossible when
// attaching has to relaunch the app to take effect.

import {
  clearBootInjection,
  deviceIsInjected,
  injectAtBoot,
  trustCaInSimulator,
} from "./capture-device";
import {
  CAPTURE_SCHEMA_VERSION,
  CaptureStore,
  type CaptureEvent,
  type CaptureMeta,
} from "./capture-store";
import { startMitmProxy, type CaptureProxy } from "./mitm-engine";

/** How often a device is re-checked against reality, however many panels are watching it. */
const CHECK_INTERVAL_MS = 10_000;

interface Device {
  store: CaptureStore;
  meta: CaptureMeta;
  proxy: CaptureProxy | null;
  /** In-flight check, shared so concurrent viewers ask the device once. */
  checking?: Promise<CaptureMeta>;
  checkedAt?: number;
}

export interface CaptureRuntimeOptions {
  startProxy?: (store: CaptureStore, onUnexpectedExit: (reason: string) => void) => Promise<CaptureProxy>;
  trustCa?: (udid: string, caPem: string) => Promise<void>;
  inject?: (udid: string, portFile: string) => Promise<void>;
  clearInjection?: (udid: string) => Promise<void>;
  /** Whether the device is still pointed at the proxy. Asked rather than remembered. */
  isInjected?: (udid: string, portFile: string) => Promise<boolean>;
}

function notEnabledMeta(udid: string): CaptureMeta {
  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    udid,
    proxyAddress: null,
    attachment: "not-enabled",
    attachError:
      "This device was not booted with network capture. Capture is applied when the device boots, so " +
      "recording its traffic needs a reboot with capture enabled.",
    intercepted: false,
  };
}

export type CaptureRuntime = ReturnType<typeof createCaptureRuntime>;

/** Devices keyed by udid; every external effect is injected so tests never touch a real simulator. */
export function createCaptureRuntime(options: CaptureRuntimeOptions = {}) {
  const startProxy =
    options.startProxy ??
    ((store: CaptureStore, onUnexpectedExit: (reason: string) => void) =>
      startMitmProxy(store, { onUnexpectedExit }));
  const trustCa = options.trustCa ?? trustCaInSimulator;
  const inject = options.inject ?? injectAtBoot;
  const clearInjection = options.clearInjection ?? clearBootInjection;
  const isInjected = options.isInjected ?? deviceIsInjected;

  const byUdid = new Map<string, Device>();

  const disableDevice = async (udid: string): Promise<void> => {
    const device = byUdid.get(udid);
    if (!device) return;
    byUdid.delete(udid);
    // Cleared first: a proxy that outlives the injection only wastes a port, but an injection that
    // outlives the proxy points every new launch at a dead one.
    await clearInjection(udid).catch(() => {});
    await device.proxy?.close().catch(() => {});
  };

  return {
    /**
     * Start capturing this device, for the life of its boot session.
     *
     * Resolves once the device is pointed at a live proxy, or once the reason it is not has been recorded.
     * It does not reject: a developer whose capture failed still wants a working simulator, and the reason
     * reaches them through the panel instead of the terminal.
     */
    async enableForDevice(udid: string): Promise<CaptureMeta> {
      const existing = byUdid.get(udid);
      if (existing) return existing.meta;

      const store = new CaptureStore();
      const meta: CaptureMeta = {
        schemaVersion: CAPTURE_SCHEMA_VERSION,
        udid,
        proxyAddress: null,
        attachment: "starting",
        attachError: null,
        intercepted: false,
      };
      const device: Device = { store, meta, proxy: null };
      byUdid.set(udid, device);

      // Reported rather than swallowed: apps launched while this was live keep sending to the dead port, so
      // their networking stays broken until they are relaunched.
      const reportProxyDeath = (reason: string) => {
        if (byUdid.get(udid) !== device) return;
        meta.attachment = "failed";
        meta.intercepted = false;
        meta.attachError =
          `${reason}\n\nApps launched on this device are still pointed at the stopped proxy, so their ` +
          "requests will fail until they are relaunched.";
        store.publishMeta(meta);
      };

      try {
        const proxy = await startProxy(store, reportProxyDeath);
        device.proxy = proxy;
        meta.proxyAddress = proxy.address;

        // Without trust every HTTPS handshake fails, which looks identical to "nothing happened".
        await trustCa(udid, await proxy.caPem());

        await inject(udid, proxy.portFile);
        meta.attachment = "capturing";
        meta.intercepted = true;
      } catch (error) {
        meta.attachment = "failed";
        meta.attachError = error instanceof Error ? error.message : String(error);
      }
      return meta;
    },

    /** Stop capturing and stop pointing new launches at the proxy. Apps already running are left alone. */
    disableForDevice: disableDevice,

    /** Stop every device. Used on shutdown, where leaving a proxy behind would leak a port and a CA key. */
    async disableAll(): Promise<void> {
      await Promise.all([...byUdid.keys()].map(disableDevice));
    },

    /** Attach a listener to a capturing device. Never starts or stops anything. */
    subscribe(udid: string, listener: (event: CaptureEvent) => void): { meta: CaptureMeta; unsubscribe: () => void } {
      const device = byUdid.get(udid);
      if (!device) return { meta: notEnabledMeta(udid), unsubscribe: () => {} };
      return { meta: device.meta, unsubscribe: device.store.subscribe(listener) };
    },

    metaFor(udid: string): CaptureMeta {
      return byUdid.get(udid)?.meta ?? notEnabledMeta(udid);
    },

    /**
     * Re-check a device against reality and report its state.
     *
     * The device can stop capturing without telling us — its boot session ends and the injection goes with
     * it — so a panel that trusted `metaFor` alone would keep claiming to record an app whose traffic it
     * can no longer see. Viewers are told when the answer changes.
     */
    async refreshForDevice(udid: string): Promise<CaptureMeta> {
      const device = byUdid.get(udid);
      if (!device) return notEnabledMeta(udid);
      // A failure already has a reason on it; re-checking would only replace it with a vaguer one.
      if (device.meta.attachment !== "capturing" || !device.proxy) return device.meta;

      // Shared and rate-limited across viewers. Asking costs a process launched inside the simulator,
      // which loads the injected library and probes the port — so every open panel doing it on its own
      // heartbeat would be a steady drip of work and log noise for one question with one answer.
      const now = Date.now();
      if (device.checking) return device.checking;
      if (device.checkedAt !== undefined && now - device.checkedAt < CHECK_INTERVAL_MS) return device.meta;

      const portFile = device.proxy.portFile;
      device.checking = (async () => {
        try {
          const live = await isInjected(udid, portFile).catch(() => false);
          if (live) return device.meta;

          device.meta.attachment = "failed";
          device.meta.intercepted = false;
          device.meta.attachError =
            "This device stopped capturing. It was restarted, or shut down, since capture was applied — " +
            "capture is set up when a device boots, so it does not survive a restart. Reboot with capture " +
            "to start again.";
          device.store.publishMeta(device.meta);
          return device.meta;
        } finally {
          device.checkedAt = Date.now();
          device.checking = undefined;
        }
      })();
      return device.checking;
    },

    /** The live store for a device, or null when it is not capturing. */
    storeFor(udid: string): CaptureStore | null {
      return byUdid.get(udid)?.store ?? null;
    },

    /**
     * Throughput measured by the proxy, or null when the host counters are the better source.
     *
     * Only meaningful while the device is actually capturing. Its traffic then reaches the network over
     * loopback, which host-level accounting deliberately excludes, so the proxy's own byte counts are all
     * there is. Null — rather than a zeroed reading — so the sampler falls back instead of reporting idle.
     */
    throughputFor(udid: string): { in: number; out: number } | null {
      const device = byUdid.get(udid);
      if (!device || device.meta.attachment !== "capturing") return null;
      return device.store.throughput();
    },
  };
}

/** One runtime per server: boot decides what captures, and the routes only read it. */
export const captureRuntime = createCaptureRuntime();
