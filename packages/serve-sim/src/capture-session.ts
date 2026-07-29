// One capture session per device: the proxy, its store, the simulator trust install, and the app
// relaunch that points that app's traffic through the proxy. Started on the first subscriber and torn
// down after the last, ref-counted like the metrics sampler cache, so several viewers of one device
// share a single session rather than each standing up their own.
//
// Everything a session changes lives inside the app it launched. It does not touch the host's network
// settings, so there is no machine-wide state to reconcile, no claim to arbitrate between processes, and
// nothing left broken if this process dies — which is what an earlier host-system-proxy version could
// not promise.

import { CaptureStore, type CaptureEvent, type CaptureMeta, CAPTURE_SCHEMA_VERSION } from "./capture-store";
import { trustCaInSimulator } from "./capture-ca";
import { captureInjection, type CaptureInjection } from "./capture-injection";
import { foregroundTracker, frontmostAppViaAx, isUserFacingBundle } from "./foreground-tracker";
import { startMitmProxy, type CaptureProxy } from "./mitm-engine";

interface CaptureSession {
  store: CaptureStore;
  meta: CaptureMeta;
}

export interface CaptureSubscription {
  meta: CaptureMeta;
  unsubscribe: () => void;
}

/**
 * How long a session outlives its last viewer.
 *
 * The client reconnects a dropped stream after two seconds. Without a grace period that reconnect
 * arrives to find the session already destroyed and starts a new one — which relaunches the app. A
 * flaky stream then becomes a relaunch loop, with the app pointing at a dead proxy port in between. So
 * teardown waits long enough for a reconnect to be recognised as the same session.
 */
const TEARDOWN_GRACE_MS = 10_000;

interface Entry {
  session: CaptureSession;
  proxy: CaptureProxy | null;
  /** The app relaunched under the proxy, recorded so the session can report what it is capturing. */
  attached: string | null;
  starting: Promise<void>;
  /** Set while the session is waiting out the grace period; cleared if a viewer returns. */
  teardown: ReturnType<typeof setTimeout> | null;
}

export type CaptureSessionCache = ReturnType<typeof createCaptureSessionCache>;

export interface CaptureSessionCacheOptions {
  startProxy?: (
    store: CaptureStore,
    udid: string,
    /** Invoked if the proxy dies while the session is using it. */
    onUnexpectedExit: (reason: string) => void,
  ) => Promise<CaptureProxy>;
  trustCa?: (udid: string, caPem: string) => Promise<void>;
  injection?: CaptureInjection;
  /** The app to capture; defaults to whatever is frontmost on the device. */
  targetApp?: (udid: string) => Promise<string | null>;
  /** How long a session outlives its last viewer. Overridden in tests to avoid waiting it out. */
  teardownGraceMs?: number;
}

/**
 * The app to capture: whatever is in the foreground, provided it is the developer's.
 *
 * The tracker is asked first because it tails SpringBoard's visibility log and so is focus-independent.
 * `frontmostAppViaAx` only resolves while the Simulator window is the focused macOS app — which it is
 * not when the developer is driving this from a browser, i.e. always — so it is the fallback, not the
 * primary. A system bundle is refused rather than captured: attaching from the home screen would
 * otherwise terminate and relaunch SpringBoard.
 */
async function defaultTargetApp(udid: string): Promise<string | null> {
  const bundleId =
    foregroundTracker.peek(udid)?.bundleId ?? (await frontmostAppViaAx(udid))?.bundleId ?? null;
  if (!bundleId || !isUserFacingBundle(bundleId)) return null;
  return bundleId;
}

/** Sessions keyed by udid; every external effect is injected so tests never touch a real device. */
export function createCaptureSessionCache(options: CaptureSessionCacheOptions = {}) {
  const startProxy =
    options.startProxy ??
    ((store: CaptureStore, _udid: string, onUnexpectedExit: (reason: string) => void) =>
      startMitmProxy(store, { onUnexpectedExit }));
  const trustCa = options.trustCa ?? trustCaInSimulator;
  const injection = options.injection ?? captureInjection;
  const targetApp = options.targetApp ?? defaultTargetApp;
  const teardownGraceMs = options.teardownGraceMs ?? TEARDOWN_GRACE_MS;

  const byUdid = new Map<string, Entry>();

  return {
    /** Attach a listener for one device, starting the session if it is the first. */
    subscribe(udid: string, listener: (event: CaptureEvent) => void): CaptureSubscription {
      let entry = byUdid.get(udid);
      if (entry?.teardown) {
        // A viewer came back inside the grace period. Keep the session — and with it the app that is
        // already relaunched and pointed at the proxy — rather than rebuilding both.
        clearTimeout(entry.teardown);
        entry.teardown = null;
      }
      if (!entry) {
        const store = new CaptureStore();
        const meta: CaptureMeta = {
          schemaVersion: CAPTURE_SCHEMA_VERSION,
          udid,
          proxyAddress: null,
          attachment: "pending",
          attachError: null,
        };
        const created: Entry = {
          session: { store, meta },
          proxy: null,
          attached: null,
          starting: Promise.resolve(),
          teardown: null,
        };
        // Reported rather than swallowed: the app keeps sending to the dead port, so its networking is
        // broken until it is relaunched, and silence would present that as the app going quiet.
        const reportProxyDeath = (reason: string) => {
          if (byUdid.get(udid) !== created) return;
          meta.attachment = "failed";
          meta.attachError =
            `${reason}\n\nThe app is still pointed at the stopped proxy, so its requests will fail ` +
            "until you relaunch it. Start capture again to attach a new proxy.";
          store.publishMeta(meta);
        };

        created.starting = (async () => {
          const proxy = await startProxy(store, udid, reportProxyDeath);
          created.proxy = proxy;
          meta.proxyAddress = proxy.address;

          // Without trust every HTTPS handshake from the app fails, which looks identical to "nothing
          // happened". Report it rather than pointing the app at a proxy it will refuse.
          try {
            await trustCa(udid, await proxy.caPem());
          } catch (error) {
            meta.attachment = "failed";
            meta.attachError = `Could not trust the capture certificate in this simulator: ${
              error instanceof Error ? error.message : String(error)
            }`;
            return;
          }

          const bundleId = await targetApp(udid).catch(() => null);
          if (!bundleId) {
            // Nothing to inject into. The proxy address is still reported so a developer who wants to
            // point something at it by hand can.
            meta.attachment = "no-target";
            meta.attachError =
              "No app of yours is in the foreground, so there is nothing to capture. Open the app you " +
              "want to inspect — a system screen like the home screen or Settings is skipped — and " +
              "start capture again.";
            return;
          }

          const [, port] = proxy.address.split(":");
          try {
            await injection.attach(udid, bundleId, Number(port));
            created.attached = bundleId;
            meta.attachment = "attached";
          } catch (error) {
            meta.attachment = "failed";
            meta.attachError =
              error instanceof Error ? error.message : "Could not relaunch the app with capture enabled";
          }
        })().catch((error: unknown) => {
          // The proxy itself failed to start. Surfaced on the record rather than swallowed, or the panel
          // would sit on "starting the capture proxy" forever with the reason thrown away.
          meta.attachment = "failed";
          meta.attachError =
            error instanceof Error ? error.message : "Could not start the capture proxy";
        });
        entry = created;
        byUdid.set(udid, created);
      }

      const off = entry.session.store.subscribe(listener);
      const current = entry;
      return {
        meta: current.session.meta,
        unsubscribe: () => {
          off();
          // Identity-guard the eviction: a stale or double-called unsubscribe must not tear down a
          // session a later subscriber created for this udid.
          if (current.session.store.listenerCount > 0 || byUdid.get(udid) !== current) return;
          if (current.teardown) return; // already counting down
          current.teardown = setTimeout(() => {
            // Re-check: a viewer may have returned and left again, and the entry may have been replaced.
            if (byUdid.get(udid) !== current || current.session.store.listenerCount > 0) return;
            byUdid.delete(udid);
            void current.starting
              .then(async () => {
                // The app is deliberately left alone. Restarting it to unset a per-process proxy would
                // cost the developer their app's state for a setting that dies with the process anyway;
                // its requests fail until they next launch it, and then it comes up clean.
                current.attached = null;
                // The certificate is deliberately left trusted: its private key dies with the proxy's
                // confdir below, and simctl cannot remove one root without wiping the whole keychain.
                await current.proxy?.close();
              })
              .catch(() => {
                // Teardown is best-effort; nothing outside the app and the simulator was changed, so a
                // failure here cannot leave the developer's machine in a worse state.
              });
          }, teardownGraceMs);
        },
      };
    },

    /** Resolves once the proxy is listening, trust is installed, and the app has been relaunched. */
    async whenReady(udid: string): Promise<CaptureMeta | null> {
      const entry = byUdid.get(udid);
      if (!entry) return null;
      await entry.starting;
      return entry.session.meta;
    },

    /** The live store for a device, or null when no session is running. */
    storeFor(udid: string): CaptureStore | null {
      return byUdid.get(udid)?.session.store ?? null;
    },

    /**
     * Throughput measured by the proxy, or null when the host counters are the better source.
     *
     * Only meaningful once the app is actually routed through the proxy. It then reaches the network
     * over loopback, which host-level accounting deliberately excludes, so the proxy's own byte counts
     * are all there is. Null — rather than a zeroed reading — when capture is not attachment, so the
     * sampler falls back to the host counters instead of reporting the app as idle.
     */
    throughputFor(udid: string): { in: number; out: number } | null {
      const entry = byUdid.get(udid);
      if (!entry || entry.session.meta.attachment !== "attached") return null;
      return entry.session.store.throughput();
    },
  };
}
