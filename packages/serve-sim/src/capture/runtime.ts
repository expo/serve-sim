import {
  bootInjectionCleared,
  clearBootInjection,
  injectAtBoot,
  trustCaInSimulator,
} from "./device";
import {
  CAPTURE_SCHEMA_VERSION,
  CaptureStore,
  type CaptureEvent,
  type CaptureMeta,
} from "./store";
import { startMitmProxy, type CaptureProxy, type MitmProxyDeps } from "./mitm-engine";
import { DEFAULT_CAPTURE_FIELDS, type CaptureField } from "./fields";

/** Failed enable after publishing `attachment: "failed"`. Simulator stays usable. */
export class CaptureEnableError extends Error {
  readonly meta: CaptureMeta;

  constructor(meta: CaptureMeta) {
    super(meta.attachError ?? "Network capture could not start");
    this.name = "CaptureEnableError";
    this.meta = meta;
  }
}

interface CaptureSession {
  store: CaptureStore;
  meta: CaptureMeta;
  proxy: CaptureProxy | null;
}

export interface CaptureRuntimeOptions {
  /** Parts of an exchange this server may keep. Metadata only when omitted. */
  fields?: readonly CaptureField[];
  startProxy?: (store: CaptureStore, deps: MitmProxyDeps) => Promise<CaptureProxy>;
  trustCa?: (udid: string, caPem: string) => Promise<void>;
  inject?: (udid: string, portFile: string) => Promise<void>;
  clearInjection?: (udid: string) => Promise<void>;
  /** Whether teardown actually removed the injected variables. */
  injectionCleared?: (udid: string) => Promise<boolean>;
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
    droppedOversizedBodies: 0,
  };
}

export type CaptureRuntime = ReturnType<typeof createCaptureRuntime>;

export function createCaptureRuntime(options: CaptureRuntimeOptions = {}) {
  // Read at enable time, so changing it does not affect proxies already running.
  let policy: readonly CaptureField[] = options.fields ?? DEFAULT_CAPTURE_FIELDS;
  const startProxy =
    options.startProxy ?? ((store: CaptureStore, deps: MitmProxyDeps) => startMitmProxy(store, deps));
  const trustCa = options.trustCa ?? trustCaInSimulator;
  const inject = options.inject ?? injectAtBoot;
  const clearInjection = options.clearInjection ?? clearBootInjection;
  const stillCleared = options.injectionCleared ?? bootInjectionCleared;

  const byUdid = new Map<string, CaptureSession>();
  const teardowns = new Map<string, Promise<void>>();

  const tearDownSession = async (udid: string, session: CaptureSession): Promise<void> => {
    // Clear injection before closing the proxy so launches aren't aimed at a dead port.
    try {
      await clearInjection(udid);
      if (!(await stillCleared(udid))) {
        console.error(
          `Network capture: ${udid} still has the capture library injected after teardown. Apps launched ` +
            "on it will keep loading it until the device is rebooted.",
        );
      }
    } catch (error) {
      console.error(
        `Network capture: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      await session.proxy?.close();
    } catch (error) {
      console.warn(
        `Network capture: closing proxy for ${udid} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  };

  /**
   * Stop capturing on a device, once.
   *
   * A second caller joins the teardown already running instead of finding an empty map and returning
   * straight away. Shutdown has two callers, and one of them exits the process when it returns.
   */
  const disableDevice = (udid: string): Promise<void> => {
    const running = teardowns.get(udid);
    if (running) return running;
    const session = byUdid.get(udid);
    if (!session) return Promise.resolve();
    byUdid.delete(udid);
    const teardown = tearDownSession(udid, session).finally(() => teardowns.delete(udid));
    teardowns.set(udid, teardown);
    return teardown;
  };

  return {
    setFields(next: readonly CaptureField[]): void {
      policy = next;
    },

    /** Capturing meta, or {@link CaptureEnableError} after publishing failed meta. */
    async enableForDevice(udid: string): Promise<CaptureMeta> {
      // A teardown owns the device's injection until it finishes. Arming on top of one means its clear
      // lands after this call's inject, leaving a session that reports capturing over a bare device.
      // Only awaited when one is running, so an ordinary enable still registers its session synchronously.
      const tearingDown = teardowns.get(udid);
      if (tearingDown) await tearingDown;

      const existing = byUdid.get(udid);
      if (existing) {
        if (existing.meta.attachment !== "failed") return existing.meta;
        await disableDevice(udid);
      }

      const store = new CaptureStore();
      const meta: CaptureMeta = {
        schemaVersion: CAPTURE_SCHEMA_VERSION,
        udid,
        proxyAddress: null,
        attachment: "starting",
        attachError: null,
        droppedOversizedBodies: 0,
      };
      const session: CaptureSession = { store, meta, proxy: null };
      byUdid.set(udid, session);

      const reportProxyDeath = (reason: string) => {
        if (byUdid.get(udid) !== session) return;
        meta.attachment = "failed";
        meta.attachError =
          `${reason}\n\nApps launched on this device are still pointed at the stopped proxy, so their ` +
          "requests will fail until they are relaunched.";
        store.publishMeta(meta);
      };

      // disableForDevice tore down whatever existed when it ran, so anything started after that point is
      // this call's alone to undo.
      const assertStillOurs = () => {
        if (byUdid.get(udid) !== session) {
          throw new Error("Capture was turned off for this device while it was starting.");
        }
      };

      try {
        const proxy = await startProxy(store, {
          fields: policy,
          onUnexpectedExit: reportProxyDeath,
          onOversizedControlBody: () => {
            if (byUdid.get(udid) !== session) return;
            meta.droppedOversizedBodies += 1;
            store.publishMeta(meta);
          },
        });
        session.proxy = proxy;
        meta.proxyAddress = proxy.address;
        assertStillOurs();

        await trustCa(udid, await proxy.caPem());
        assertStillOurs();

        await inject(udid, proxy.portFile);
        assertStillOurs();
        // The proxy can die during the two steps above. Overwriting the failure it published with
        // "capturing" reports a dead proxy as a healthy one.
        if (meta.attachment === "failed") {
          throw new Error(meta.attachError ?? "The capture proxy stopped while capture was starting.");
        }
        meta.attachment = "capturing";
      } catch (error) {
        meta.attachment = "failed";
        meta.attachError = error instanceof Error ? error.message : String(error);
        const successor = byUdid.get(udid);
        // A successor armed the device after this call was superseded, so its injection is not ours to clear.
        if (!successor || successor === session) {
          try {
            await clearInjection(udid);
          } catch (clearError) {
            console.warn(
              `Network capture: clearing injection after failed enable for ${udid}:`,
              clearError instanceof Error ? clearError.message : clearError,
            );
          }
        }
        try {
          await session.proxy?.close();
        } catch (closeError) {
          console.warn(
            `Network capture: closing proxy after failed enable for ${udid}:`,
            closeError instanceof Error ? closeError.message : closeError,
          );
        }
        session.proxy = null;
        meta.proxyAddress = null;
        store.publishMeta(meta);
        throw new CaptureEnableError(meta);
      }
      store.publishMeta(meta);
      return meta;
    },

    disableForDevice: disableDevice,

    async disableAll(): Promise<void> {
      const devices = new Set([...byUdid.keys(), ...teardowns.keys()]);
      await Promise.all([...devices].map(disableDevice));
    },

    subscribe(udid: string, listener: (event: CaptureEvent) => void): { meta: CaptureMeta; unsubscribe: () => void } {
      const session = byUdid.get(udid);
      if (!session) return { meta: notEnabledMeta(udid), unsubscribe: () => {} };
      return { meta: session.meta, unsubscribe: session.store.subscribe(listener) };
    },

    metaFor(udid: string): CaptureMeta {
      return byUdid.get(udid)?.meta ?? notEnabledMeta(udid);
    },

    storeFor(udid: string): CaptureStore | null {
      return byUdid.get(udid)?.store ?? null;
    },

    clearForDevice(udid: string): boolean {
      const session = byUdid.get(udid);
      if (!session) return false;
      session.store.clear();
      return true;
    },

    /** Null when not capturing so the sampler can fall back to host counters. */
    throughputFor(udid: string): { netInBytesPerSec: number; netOutBytesPerSec: number } | null {
      const session = byUdid.get(udid);
      if (!session || session.meta.attachment !== "capturing") return null;
      return session.store.throughput();
    },
  };
}

export const captureRuntime = createCaptureRuntime();
