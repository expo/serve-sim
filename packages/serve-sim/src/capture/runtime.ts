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
  cleanup?: Promise<void>;
}

interface EnableRequest {
  cancelled: boolean;
  failed: boolean;
  promise: Promise<CaptureMeta>;
}

class DeviceOperationQueue {
  readonly #operations = new Map<string, Promise<void>>();

  enqueue<T>(udid: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operations.get(udid);
    const result = previous ? previous.then(operation) : operation();
    const settled = result.then(
      () => {},
      () => {},
    );
    this.#operations.set(udid, settled);
    void settled.then(() => {
      if (this.#operations.get(udid) === settled) this.#operations.delete(udid);
    });
    return result;
  }

  devices(): IterableIterator<string> {
    return this.#operations.keys();
  }
}

export interface CaptureRuntimeOptions {
  fields?: readonly CaptureField[];
  startProxy?: (store: CaptureStore, deps: MitmProxyDeps) => Promise<CaptureProxy>;
  trustCa?: (udid: string, caPem: string) => Promise<void>;
  inject?: (udid: string, portFile: string) => Promise<void>;
  clearInjection?: (udid: string) => Promise<void>;
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

function cancelledMeta(udid: string): CaptureMeta {
  return {
    ...notEnabledMeta(udid),
    attachment: "failed",
    attachError: "Capture was turned off while it was waiting to start. Enable it again to retry.",
  };
}

function assertRequested(udid: string, request: EnableRequest): void {
  if (request.cancelled) throw new CaptureEnableError(cancelledMeta(udid));
}

export function createCaptureRuntime(options: CaptureRuntimeOptions = {}) {
  let policy: readonly CaptureField[] = options.fields ?? DEFAULT_CAPTURE_FIELDS;
  const startProxy =
    options.startProxy ?? ((store: CaptureStore, deps: MitmProxyDeps) => startMitmProxy(store, deps));
  const trustCa = options.trustCa ?? trustCaInSimulator;
  const inject = options.inject ?? injectAtBoot;
  const clearInjection = options.clearInjection ?? clearBootInjection;
  const stillCleared = options.injectionCleared ?? bootInjectionCleared;

  const byUdid = new Map<string, CaptureSession>();
  const operations = new DeviceOperationQueue();
  const enables = new Map<string, EnableRequest>();
  let serverEnabled = false;

  const tearDownSession = async (udid: string, session: CaptureSession): Promise<void> => {
    session.cleanup ??= (async () => {
      try {
        await clearInjection(udid);
        if (!(await stillCleared(udid))) {
          console.error(
            `Network capture: ${udid} still has the capture library injected after teardown. Apps launched ` +
              "on it will keep loading it until the device is rebooted.",
          );
        }
      } catch (error) {
        console.error(`Network capture: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await session.proxy?.close();
      } catch (error) {
        console.warn(
          `Network capture: closing proxy for ${udid} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    })();
    await session.cleanup;
  };

  const disableDevice = (udid: string): Promise<void> => {
    const pending = enables.get(udid);
    if (pending) pending.cancelled = true;
    enables.delete(udid);
    return operations.enqueue(udid, async () => {
      const session = byUdid.get(udid);
      if (!session) return;
      byUdid.delete(udid);
      await tearDownSession(udid, session);
    });
  };

  return {
    setFields(next: readonly CaptureField[]): void {
      policy = next;
    },

    isServerEnabled(): boolean {
      return serverEnabled;
    },

    markServerEnabled(): void {
      serverEnabled = true;
    },

    enableForDevice(udid: string): Promise<CaptureMeta> {
      const pending = enables.get(udid);
      if (pending && !pending.failed) {
        return pending.promise;
      }
      const request: EnableRequest = {
        cancelled: false,
        failed: false,
        promise: Promise.resolve(notEnabledMeta(udid)),
      };
      const promise = operations.enqueue(udid, async () => {
        assertRequested(udid, request);
        const existing = byUdid.get(udid);
        if (existing) {
          if (existing.meta.attachment !== "failed") return existing.meta;
          await tearDownSession(udid, existing);
          assertRequested(udid, request);
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
          assertRequested(udid, request);

          await trustCa(udid, await proxy.caPem());
          assertRequested(udid, request);

          await inject(udid, proxy.portFile);
          assertRequested(udid, request);
          if (meta.attachment === "failed") {
            throw new Error(meta.attachError ?? "The capture proxy stopped while capture was starting.");
          }
          meta.attachment = "capturing";
        } catch (error) {
          request.failed = true;
          meta.attachment = "failed";
          meta.attachError = error instanceof Error ? error.message : String(error);
          await tearDownSession(udid, session);
          session.proxy = null;
          meta.proxyAddress = null;
          store.publishMeta(meta);
          throw new CaptureEnableError(meta);
        }
        store.publishMeta(meta);
        return meta;
      });
      request.promise = promise;
      enables.set(udid, request);
      const forget = () => {
        if (enables.get(udid) === request) enables.delete(udid);
      };
      void promise.then(forget, forget);
      return promise;
    },

    disableForDevice: disableDevice,

    async disableAll(): Promise<void> {
      const devices = new Set([...byUdid.keys(), ...operations.devices()]);
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

    throughputFor(udid: string): { netInBytesPerSec: number; netOutBytesPerSec: number } | null {
      const session = byUdid.get(udid);
      if (!session || session.meta.attachment !== "capturing") return null;
      return session.store.throughput();
    },
  };
}

export const captureRuntime = createCaptureRuntime();
