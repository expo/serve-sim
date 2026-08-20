import { bootDevice, shutdownDevice } from "../device";
import { CaptureEnableError, captureRuntime, type CaptureRuntime } from "./runtime";
import { type CaptureMeta } from "./store";

export interface RebootDeps {
  runtime?: CaptureRuntime;
  shutdown?: (udid: string) => Promise<void>;
  boot?: (udid: string) => Promise<void>;
}

type InFlight = { enabled: boolean; promise: Promise<CaptureMeta> };
const inFlight = new Map<string, InFlight>();

/** Tear down the old session first so injection cannot point the new boot at a dead port. */
export async function rebootWithCapture(
  udid: string,
  enabled: boolean,
  deps: RebootDeps = {},
): Promise<CaptureMeta> {
  // Serialize per device. Same intent joins; opposite intent waits then runs.
  for (;;) {
    const running = inFlight.get(udid);
    if (!running) break;
    if (running.enabled === enabled) return running.promise;
    await running.promise.catch(() => {});
  }

  const runtime = deps.runtime ?? captureRuntime;
  const shutdown = deps.shutdown ?? shutdownDevice;
  const boot = deps.boot ?? bootDevice;

  const attempt = (async () => {
    await runtime.disableForDevice(udid);
    await shutdown(udid);
    await boot(udid);
    if (!enabled) return runtime.metaFor(udid);
    try {
      return await runtime.enableForDevice(udid);
    } catch (error) {
      if (error instanceof CaptureEnableError) return error.meta;
      throw error;
    }
  })();
  const entry: InFlight = { enabled, promise: attempt };
  inFlight.set(udid, entry);
  try {
    return await attempt;
  } finally {
    if (inFlight.get(udid) === entry) inFlight.delete(udid);
  }
}
