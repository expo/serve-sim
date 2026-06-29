import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { STATE_DIR } from "./state";

const SIMCAM_STATE_DIR = join(STATE_DIR, "simcam");
const MAX_HELPER_REPLY_BYTES = 64 * 1024;

interface InjectedBundlesState {
  helperPid: number;
  bundleIds: string[];
}

export interface CameraHelperReply {
  ok?: boolean;
  source?: string;
  arg?: string;
  mirror?: string;
  error?: string;
}

export interface CameraStatusReply extends CameraHelperReply {
  udid: string;
  alive: boolean;
  helperPid?: number | null;
  bundleIds?: string[];
}

export function cameraHelperPidFile(udid: string): string {
  return join(SIMCAM_STATE_DIR, `${udid}.pid`);
}

export function cameraHelperBundlesFile(udid: string): string {
  return join(SIMCAM_STATE_DIR, `${udid}.bundles.json`);
}

export function cameraHelperSocketFile(udid: string): string {
  // POSIX sun_path is 104 chars on macOS — keep this short.
  const short = createHash("sha1").update(udid).digest("hex").slice(0, 12);
  return `/tmp/serve-sim-cam-${short}.sock`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readCameraHelperPid(udid: string): number | null {
  try {
    const pid = Number(readFileSync(cameraHelperPidFile(udid), "utf-8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function cameraHelperReply(value: unknown): CameraHelperReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid camera helper reply");
  }
  const reply = value as Record<string, unknown>;
  return {
    ...(typeof reply.ok === "boolean" ? { ok: reply.ok } : {}),
    ...(typeof reply.source === "string" ? { source: reply.source } : {}),
    ...(typeof reply.arg === "string" ? { arg: reply.arg } : {}),
    ...(typeof reply.mirror === "string" ? { mirror: reply.mirror } : {}),
    ...(typeof reply.error === "string" ? { error: reply.error } : {}),
  };
}

export async function sendCameraHelperCommand(
  udid: string,
  cmd: object,
): Promise<CameraHelperReply> {
  const sockPath = cameraHelperSocketFile(udid);
  if (!existsSync(sockPath)) throw new Error("camera helper socket not found");
  const net = await import("net");
  return await new Promise((resolve, reject) => {
    const c = net.createConnection(sockPath);
    c.setEncoding("utf8");
    let buf = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (error?: unknown, reply?: CameraHelperReply) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve(reply ?? {});
    };
    c.on("data", (chunk) => {
      buf += chunk;
      if (Buffer.byteLength(buf) > MAX_HELPER_REPLY_BYTES) {
        c.destroy();
        settle(new Error("camera helper reply is too large"));
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        try {
          settle(undefined, cameraHelperReply(JSON.parse(buf.slice(0, nl)) as unknown));
        } catch (error) {
          settle(error);
        }
        c.end();
      }
    });
    c.on("error", settle);
    c.on("close", () => settle(new Error("camera helper socket closed")));
    c.write(JSON.stringify(cmd) + "\n");
    timeout = setTimeout(() => {
      c.destroy();
      settle(new Error("camera helper timed out"));
    }, 3000);
  });
}

export function isCameraHelperAlive(udid: string): boolean {
  const pid = readCameraHelperPid(udid);
  return pid !== null && isProcessAlive(pid) && existsSync(cameraHelperSocketFile(udid));
}

export function readInjectedCameraBundles(udid: string): string[] {
  const path = cameraHelperBundlesFile(udid);
  if (!existsSync(path)) return [];
  let state: InjectedBundlesState;
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const candidate = value as Partial<InjectedBundlesState>;
    if (typeof candidate.helperPid !== "number" || !Array.isArray(candidate.bundleIds)) return [];
    state = { helperPid: candidate.helperPid, bundleIds: candidate.bundleIds };
  } catch {
    return [];
  }
  const currentHelperPid = readCameraHelperPid(udid);
  if (currentHelperPid == null || state.helperPid !== currentHelperPid) return [];
  return Array.isArray(state.bundleIds)
    ? state.bundleIds.filter((bundleId): bundleId is string => typeof bundleId === "string")
    : [];
}

export async function readCameraStatus(udid: string): Promise<CameraStatusReply> {
  if (!isCameraHelperAlive(udid)) {
    return { udid, alive: false };
  }
  const helperPid = readCameraHelperPid(udid);
  const bundleIds = readInjectedCameraBundles(udid);
  try {
    const reply = await sendCameraHelperCommand(udid, { action: "status" });
    return { udid, alive: true, helperPid, bundleIds, ...reply };
  } catch (error) {
    return {
      udid,
      alive: true,
      helperPid,
      bundleIds,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
