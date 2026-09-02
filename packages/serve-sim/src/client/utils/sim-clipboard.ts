import { uploadFileToTmp } from "./drop";
import { shellEscape, type ExecResult } from "./exec";
import { HID_USAGE_BY_CODE } from "./hid";
import { simEndpoint } from "./sim-endpoint";

export const PBCOPY_INLINE_MAX = 48 * 1024;

export function pbcopyCommand(udid: string, text: string, tool: string): string {
  return `printf '%s' ${shellEscape(text)} | xcrun simctl spawn ${shellEscape(udid)} ${shellEscape(tool)}`;
}

type ExecFn = (command: string) => Promise<ExecResult>;

export type HidKeyEvent = { type: "down" | "up"; usage: number };

function hidUsage(code: keyof typeof HID_USAGE_BY_CODE): number {
  const value = HID_USAGE_BY_CODE[code];
  if (value === undefined) throw new Error(`no HID usage for ${code}`);
  return value;
}

// Ctrl+V forwards Control, and the sim ignores Control+Command+V.
function simCommandShortcutHidEvents(
  pressed: ReadonlySet<number>,
  code: "KeyV" | "KeyC" | "KeyA",
): HidKeyEvent[] {
  const controlLeft = hidUsage("ControlLeft");
  const controlRight = hidUsage("ControlRight");
  const metaLeft = hidUsage("MetaLeft");
  const metaRight = hidUsage("MetaRight");
  const shortcutKey = hidUsage(code);
  const events: HidKeyEvent[] = [];
  if (pressed.has(controlLeft)) events.push({ type: "up", usage: controlLeft });
  if (pressed.has(controlRight)) events.push({ type: "up", usage: controlRight });
  const commandAlreadyDown = pressed.has(metaLeft) || pressed.has(metaRight);
  if (!commandAlreadyDown) events.push({ type: "down", usage: metaLeft });
  events.push({ type: "down", usage: shortcutKey });
  events.push({ type: "up", usage: shortcutKey });
  if (!commandAlreadyDown) events.push({ type: "up", usage: metaLeft });
  return events;
}

export function simPasteHidEvents(pressed: ReadonlySet<number>): HidKeyEvent[] {
  return simCommandShortcutHidEvents(pressed, "KeyV");
}

export function simCopyHidEvents(pressed: ReadonlySet<number>): HidKeyEvent[] {
  return simCommandShortcutHidEvents(pressed, "KeyC");
}

export function simSelectAllHidEvents(pressed: ReadonlySet<number>): HidKeyEvent[] {
  return simCommandShortcutHidEvents(pressed, "KeyA");
}

export async function copyTextToSim(
  udid: string,
  text: string,
  exec: ExecFn,
  tool: string,
): Promise<boolean> {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= PBCOPY_INLINE_MAX) {
    const result = await exec(pbcopyCommand(udid, text, tool));
    return result.exitCode === 0;
  }

  try {
    const tmpPath = await uploadFileToTmp(new File([bytes], "clip.txt"), "serve-sim-pbcopy", "txt", exec);
    try {
      const copied = await exec(
        `xcrun simctl spawn ${shellEscape(udid)} ${shellEscape(tool)} < ${shellEscape(tmpPath)}`,
      );
      return copied.exitCode === 0;
    } finally {
      await exec(`rm -f ${shellEscape(tmpPath)}`).catch(() => {});
    }
  } catch {
    return false;
  }
}

export async function readSimClipboard(udid: string): Promise<string> {
  const endpoint = simEndpoint("api/pasteboard");
  const separator = endpoint.includes("?") ? "&" : "?";
  const response = await fetch(`${endpoint}${separator}device=${encodeURIComponent(udid)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${window.__SIM_PREVIEW__?.execToken ?? ""}`,
    },
  });
  const body = (await response.json()) as { ok?: boolean; text?: string; error?: string };
  if (!response.ok || !body.ok) {
    throw new Error(body.error ?? `Could not read the simulator pasteboard (${response.status})`);
  }
  return body.text ?? "";
}

export function copyTextViaSelection(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

export async function writeTextToBrowserClipboard(text: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (!clipboard) throw new Error("Clipboard unavailable on this origin");

  if (typeof ClipboardItem !== "undefined" && clipboard.write) {
    const item = new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }) });
    await clipboard.write([item]);
    return;
  }

  if (!clipboard.writeText) throw new Error("Clipboard unavailable on this origin");
  await clipboard.writeText(text);
}
