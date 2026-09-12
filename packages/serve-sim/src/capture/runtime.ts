import {
  bootInjectionCleared,
  clearBootInjection,
  injectAtBoot,
  isDeviceInjected,
  trustCaInSimulator,
} from "./device";
import { CaptureDiskAccumulator, captureArtifactPaths, sweepAbandonedCaptureDirs } from "./disk";
import {
  DEFAULT_CAPTURE_FIELDS,
  type CaptureField,
} from "./fields";
import {
  CAPTURE_SCHEMA_VERSION,
  CaptureStore,
  type CaptureEvent,
  type CaptureMeta,
} from "./store";
import { startMitmProxy, type CaptureProxy, type MitmProxyDeps } from "./mitm-engine";
import { serveSimVersion } from "./version";

export class CaptureEnableError extends Error {
  readonly meta: CaptureMeta;

  constructor(meta: CaptureMeta) {
    super(meta.attachError ?? "Network capture could not start");
    this.name = "CaptureEnableError";
    this.meta = meta;
  }
}

const CHECK_INTERVAL_MS = 10_000;
const INJECT_MISS_THRESHOLD = 2;

interface CaptureSession {
  store: CaptureStore;
  meta: CaptureMeta;
  proxy: CaptureProxy | null;
  cleanup?: Promise<void>;
  disk: CaptureDiskAccumulator | null;
  stopDisk: (() => Promise<void>) | null;
  checking?: Promise<CaptureMeta>;
  checkedAt?: number;
  injectMisses?: number;
}

interface EnableRequest {
  cancelled: boolean;
  failed: boolean;
  fields: readonly CaptureField[];
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
  isInjected?: (udid: string, portFile: string) => Promise<boolean>;
  checkIntervalMs?: number;
  creatorVersion?: string;
  /** How often to stream-rebuild capture.har from the NDJSON entry log (tests). */
  flushIntervalMs?: number;
  writeDiskArtifacts?: boolean;
  captureDirFor?: (udid: string) => string;
}

function notEnabledMeta(udid: string, fields: readonly CaptureField[]): CaptureMeta {
  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    udid,
    proxyAddress: null,
    attachment: "not-enabled",
    attachError:
      "This device was not booted with network capture. Capture is applied when the device boots, so " +
      "recording its traffic needs a reboot with capture enabled.",
    droppedOversizedBodies: 0,
    fields: [...fields],
  };
}

export type CaptureRuntime = ReturnType<typeof createCaptureRuntime>;

function cancelledMeta(udid: string, fields: readonly CaptureField[]): CaptureMeta {
  return {
    ...notEnabledMeta(udid, fields),
    attachment: "failed",
    attachError: "Capture was turned off while it was waiting to start. Enable it again to retry.",
  };
}

function assertRequested(udid: string, request: EnableRequest): void {
  if (request.cancelled) throw new CaptureEnableError(cancelledMeta(udid, request.fields));
}

export function createCaptureRuntime(options: CaptureRuntimeOptions = {}) {
  let policy: readonly CaptureField[] = options.fields ?? DEFAULT_CAPTURE_FIELDS;
  const startProxy =
    options.startProxy ?? ((store: CaptureStore, deps: MitmProxyDeps) => startMitmProxy(store, deps));
  const trustCa = options.trustCa ?? trustCaInSimulator;
  const inject = options.inject ?? injectAtBoot;
  const clearInjection = options.clearInjection ?? clearBootInjection;
  const stillCleared = options.injectionCleared ?? bootInjectionCleared;
  const isInjected = options.isInjected ?? isDeviceInjected;
  const checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS;
  const writeDiskArtifacts = options.writeDiskArtifacts !== false;
  const creatorVersion = options.creatorVersion ?? "0.0.0";

  const byUdid = new Map<string, CaptureSession>();
  const operations = new DeviceOperationQueue();
  const enables = new Map<string, EnableRequest>();
  let serverEnabled = false;

  const attachDisk = (udid: string, store: CaptureStore): Pick<CaptureSession, "disk" | "stopDisk"> => {
    if (!writeDiskArtifacts) return { disk: null, stopDisk: null };
    // Reclaim what a crashed run left behind before adding to it. Directories for devices this server is
    // capturing are kept; everything else under the state directory has no owner.
    if (!options.captureDirFor) sweepAbandonedCaptureDirs([...byUdid.keys(), udid]);
    const paths = options.captureDirFor
      ? {
          dir: options.captureDirFor(udid),
          networkCapturePath: undefined,
          harPath: undefined,
        }
      : captureArtifactPaths(udid);
    const disk = new CaptureDiskAccumulator({
      dir: paths.dir,
      networkCapturePath: paths.networkCapturePath,
      harPath: paths.harPath,
      creatorVersion,
      flushIntervalMs: options.flushIntervalMs,
    });
    return { disk, stopDisk: disk.attach(store) };
  };

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
      try {
        await session.stopDisk?.();
      } catch (error) {
        console.warn(
          `Network capture: closing disk capture for ${udid} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
      session.stopDisk = null;
      session.disk = null;
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
    creatorVersion,

    /** Snapshot of the allowlisted capture fields for new sessions. */
    getFields(): readonly CaptureField[] {
      return policy;
    },

    /** Set what every device this server enables is allowed to keep. */
    setFields(next: readonly CaptureField[]): void {
      policy = next;
    },

    getServerEnabled(): boolean {
      return serverEnabled;
    },

    setServerEnabled(next: boolean): void {
      serverEnabled = next;
    },

    enableForDevice(udid: string): Promise<CaptureMeta> {
      const pending = enables.get(udid);
      if (pending && !pending.failed) {
        return pending.promise;
      }
      const request: EnableRequest = {
        cancelled: false,
        failed: false,
        fields: [...policy],
        promise: Promise.resolve(notEnabledMeta(udid, policy)),
      };
      const promise = operations.enqueue(udid, async () => {
        assertRequested(udid, request);
        const existing = byUdid.get(udid);
        if (existing) {
          if (existing.meta.attachment !== "failed") return existing.meta;
          await tearDownSession(udid, existing);
          assertRequested(udid, request);
        }

        const sessionFields = [...request.fields];
        const store = new CaptureStore();
        const meta: CaptureMeta = {
          schemaVersion: CAPTURE_SCHEMA_VERSION,
          udid,
          proxyAddress: null,
          attachment: "starting",
          attachError: null,
          droppedOversizedBodies: 0,
          fields: sessionFields,
        };
        const { disk, stopDisk } = attachDisk(udid, store);
        const session: CaptureSession = { store, meta, proxy: null, disk, stopDisk };
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
            fields: sessionFields,
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
      if (!session) return { meta: notEnabledMeta(udid, policy), unsubscribe: () => {} };
      return { meta: session.meta, unsubscribe: session.store.subscribe(listener) };
    },

    metaFor(udid: string): CaptureMeta {
      return byUdid.get(udid)?.meta ?? notEnabledMeta(udid, policy);
    },

    /** Re-check injection; publish meta only on change. */
    async refreshForDevice(udid: string): Promise<CaptureMeta> {
      const session = byUdid.get(udid);
      if (!session) return notEnabledMeta(udid, policy);
      if (session.meta.attachment !== "capturing" || !session.proxy) return session.meta;

      const now = Date.now();
      if (session.checking) return session.checking;
      if (session.checkedAt !== undefined && now - session.checkedAt < checkIntervalMs) return session.meta;

      const portFile = session.proxy.portFile;
      session.checking = (async () => {
        try {
          let live: boolean;
          try {
            live = await isInjected(udid, portFile);
          } catch (error) {
            console.warn(
              `Network capture: injection probe for ${udid} failed:`,
              error instanceof Error ? error.message : error,
            );
            return session.meta;
          }
          if (live) {
            session.injectMisses = 0;
            return session.meta;
          }

          session.injectMisses = (session.injectMisses ?? 0) + 1;
          if (session.injectMisses < INJECT_MISS_THRESHOLD) return session.meta;

          session.meta.attachment = "failed";
          session.meta.attachError =
            "This device stopped capturing. It was restarted, or shut down, since capture was applied — " +
            "capture is set up when a device boots, so it does not survive a restart. Reboot with capture " +
            "to start again.";
          session.store.publishMeta(session.meta);
          return session.meta;
        } finally {
          session.checkedAt = Date.now();
          session.checking = undefined;
        }
      })();
      return session.checking;
    },

    storeFor(udid: string): CaptureStore | null {
      return byUdid.get(udid)?.store ?? null;
    },

    artifactPathsFor(
      udid: string,
    ): { networkCapturePath: string; harPath: string; entriesPath: string } | null {
      const disk = byUdid.get(udid)?.disk;
      if (!disk) return null;
      return {
        networkCapturePath: disk.networkCapturePath,
        harPath: disk.harPath,
        entriesPath: disk.entriesPath,
      };
    },

    /** Flush NDJSON → capture.har and return its path, or null if not capturing to disk. */
    async flushHarPathFor(udid: string): Promise<string | null> {
      const disk = byUdid.get(udid)?.disk;
      if (!disk) return null;
      await disk.flush();
      return disk.harPath;
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

export const captureRuntime = createCaptureRuntime({
  creatorVersion: serveSimVersion(),
});
