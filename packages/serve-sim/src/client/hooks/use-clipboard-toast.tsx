import { useCallback, useMemo } from "react";
import { toast as sonnerToast } from "sonner";
import { ClipboardToastContent } from "../components/app-toasts";
import {
  copyTextViaSelection,
  readSimClipboard,
  writeTextToBrowserClipboard,
} from "../utils/sim-clipboard";

export type ClipboardToast = {
  status: "pending" | "copied" | "manual" | "error";
  message: string;
};

const DISMISS_MS = 3000;
const MANUAL_DISMISS_MS = 12_000;

const MANUAL_TOAST_ID = "sim-clipboard-manual";
const COPY_TOAST_ID = "sim-clipboard-copy";
const PASTE_TOAST_ID = "sim-clipboard-paste";

function renderToast(
  status: ClipboardToast["status"],
  message: string,
  id: string,
  onCopy?: () => void,
): void {
  const toast: ClipboardToast = { status, message };
  sonnerToast.custom(() => <ClipboardToastContent toast={toast} onCopy={onCopy} />, {
    id,
    duration:
      status === "pending" ? Infinity : status === "manual" ? MANUAL_DISMISS_MS : DISMISS_MS,
  });
}

export function useClipboardToast(deviceUdid: string, sendCopyShortcut: () => Promise<void>) {
  const showManual = useCallback((message: string, text: string) => {
    renderToast("manual", message, MANUAL_TOAST_ID, () => {
      const copied = copyTextViaSelection(text);
      renderToast(
        copied ? "copied" : "error",
        copied ? "Copied from simulator" : "Copy failed",
        MANUAL_TOAST_ID,
      );
    });
  }, []);

  const copyFromSim = useCallback(async () => {
    renderToast("pending", "Reading simulator clipboard…", COPY_TOAST_ID);
    try {
      await sendCopyShortcut();
      const text = await readSimClipboard(deviceUdid);
      if (!text) {
        renderToast("copied", "Simulator clipboard is empty", COPY_TOAST_ID);
        return;
      }

      try {
        await writeTextToBrowserClipboard(text);
        renderToast("copied", "Copied from simulator", COPY_TOAST_ID);
      } catch {
        sonnerToast.dismiss(COPY_TOAST_ID);
        showManual("Ready — one click to copy", text);
      }
    } catch (error) {
      renderToast(
        "error",
        error instanceof Error ? error.message : "Copy failed",
        COPY_TOAST_ID,
      );
    }
  }, [deviceUdid, sendCopyShortcut, showManual]);

  const pasteStarted = useCallback(() => {
    renderToast("pending", "Pasting into the simulator…", PASTE_TOAST_ID);
  }, []);

  const pasteSettled = useCallback((ok: boolean, error = "Could not write to the simulator clipboard") => {
    if (ok) renderToast("copied", "Pasted into simulator", PASTE_TOAST_ID);
    else renderToast("error", error, PASTE_TOAST_ID);
  }, []);

  return useMemo(
    () => ({ copyFromSim, pasteStarted, pasteSettled }),
    [copyFromSim, pasteStarted, pasteSettled],
  );
}
