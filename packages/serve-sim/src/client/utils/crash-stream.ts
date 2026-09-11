import type { CrashMeta } from "../../crash/runtime";
import type { CrashSummary } from "../../crash/store";

export type CrashStreamFrame =
  | { type: "meta"; meta: CrashMeta }
  | { type: "list"; crashes: CrashSummary[] }
  | { type: "crash" | "recurred"; record: CrashSummary }
  | { type: "evicted"; id: string };

export type CrashListState = { meta: CrashMeta | null; crashes: CrashSummary[] };

export const EMPTY_CRASH_LIST: CrashListState = { meta: null, crashes: [] };

export function parseCrashFrame(data: string): CrashStreamFrame | null {
  try {
    const parsed = JSON.parse(data) as CrashStreamFrame;
    return typeof parsed?.type === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function applyCrashFrame(state: CrashListState, frame: CrashStreamFrame): CrashListState {
  switch (frame.type) {
    case "meta":
      return { ...state, meta: frame.meta };
    // The list is authoritative: a reconnect replays it, so it also drops what the device evicted.
    case "list":
      return { ...state, crashes: frame.crashes };
    case "evicted":
      return { ...state, crashes: state.crashes.filter((crash) => crash.id !== frame.id) };
    default:
      return {
        ...state,
        crashes: [frame.record, ...state.crashes.filter((crash) => crash.id !== frame.record.id)].sort(
          (a, b) => b.lastSeen - a.lastSeen
        ),
      };
  }
}
