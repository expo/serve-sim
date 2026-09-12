import { captureRuntime, CaptureEnableError } from "./runtime";
import type { CaptureMeta } from "./store";

type CaptureStartMeta = Pick<CaptureMeta, "proxyAddress">;

export interface StartCaptureDeps {
  enable?: (udid: string) => Promise<CaptureStartMeta>;
  onStarted?: (meta: CaptureStartMeta) => void;
  onFailed?: (reason: string) => void;
}

export async function startCaptureForDevice(
  udid: string,
  deps: StartCaptureDeps = {},
): Promise<void> {
  try {
    const meta = await (deps.enable ?? captureRuntime.enableForDevice)(udid);
    deps.onStarted?.(meta);
  } catch (error) {
    const reason =
      error instanceof CaptureEnableError
        ? error.meta.attachError
        : error instanceof Error
          ? error.message
          : String(error);
    deps.onFailed?.(reason ?? "Unknown capture startup failure");
  }
}
