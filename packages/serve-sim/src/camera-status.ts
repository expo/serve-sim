import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { STATE_DIR } from "./state";

const SIMCAM_STATE_DIR = join(STATE_DIR, "simcam");

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

export async function sendCameraHelperCommand(
  udid: string,
  cmd: object,
): Promise<CameraHelperReply> {
  const sockPath = cameraHelperSocketFile(udid);
  if (!existsSync(sockPath)) throw new Error("camera helper socket not found");
  const net = await import("net");
  return await new Promise((resolve, reject) => {
    const c = net.createConnection(sockPath);
    let buf = "";
    let settled = false;
    c.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0 && !settled) {
        settled = true;
        try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
        c.end();
      }
    });
    c.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
    c.on("close", () => { if (!settled) { settled = true; reject(new Error("socket closed")); } });
    c.write(JSON.stringify(cmd) + "\n");
    setTimeout(() => {
      if (!settled) {
        settled = true;
        c.destroy();
        reject(new Error("helper timeout"));
      }
    }, 3000);
  });
}

export function isCameraHelperAlive(udid: string): boolean {
  const pf = cameraHelperPidFile(udid);
  if (!existsSync(pf)) return false;
  const pid = Number(readFileSync(pf, "utf-8").trim());
  return Number.isFinite(pid) && isProcessAlive(pid) && existsSync(cameraHelperSocketFile(udid));
}

export function readInjectedCameraBundles(udid: string): string[] {
  const path = cameraHelperBundlesFile(udid);
  if (!existsSync(path)) return [];
  let state: InjectedBundlesState;
  try {
    state = JSON.parse(readFileSync(path, "utf-8")) as InjectedBundlesState;
  } catch {
    return [];
  }
  let currentHelperPid: number | null = null;
  try {
    currentHelperPid = Number(readFileSync(cameraHelperPidFile(udid), "utf-8").trim()) || null;
  } catch {}
  if (currentHelperPid == null || state.helperPid !== currentHelperPid) return [];
  return Array.isArray(state.bundleIds) ? state.bundleIds : [];
}

export async function readCameraStatus(udid: string): Promise<CameraStatusReply> {
  if (!isCameraHelperAlive(udid)) {
    return { udid, alive: false };
  }
  let helperPid: number | null = null;
  try {
    helperPid = Number(readFileSync(cameraHelperPidFile(udid), "utf-8").trim()) || null;
  } catch {}
  const bundleIds = readInjectedCameraBundles(udid);
  try {
    const reply = await sendCameraHelperCommand(udid, { action: "status" });
    return { udid, alive: true, helperPid, bundleIds, ...reply };
  } catch (e: any) {
    return { udid, alive: true, helperPid, bundleIds, error: e?.message ?? String(e) };
  }
}
