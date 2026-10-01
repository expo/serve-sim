import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { sendHelperSocketCommand } from "./helper-socket";
import { stateDir } from "./state";

export function cameraStateDir(): string {
  return join(stateDir(), "simcam");
}

interface InjectedBundlesState {
  helperPid: number;
  bundleIds: string[];
}

export interface CameraHelperReply {
  [key: string]: unknown;
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
  return join(cameraStateDir(), `${udid}.pid`);
}

export function cameraHelperBundlesFile(udid: string): string {
  return join(cameraStateDir(), `${udid}.bundles.json`);
}

export function cameraHelperSocketFile(udid: string): string {
  // POSIX sun_path is 104 chars on macOS, so keep this short.
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

export async function sendCameraHelperCommand(
  udid: string,
  command: object,
): Promise<CameraHelperReply> {
  const socketPath = cameraHelperSocketFile(udid);
  if (!existsSync(socketPath)) throw new Error("camera helper socket not found");
  return sendHelperSocketCommand(socketPath, command);
}

export function isCameraHelperAlive(udid: string): boolean {
  const pid = readCameraHelperPid(udid);
  return pid !== null && isProcessAlive(pid) && existsSync(cameraHelperSocketFile(udid));
}

export function readInjectedCameraBundles(udid: string): string[] {
  let state: InjectedBundlesState;
  try {
    const value = JSON.parse(readFileSync(cameraHelperBundlesFile(udid), "utf-8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const candidate = value as Partial<InjectedBundlesState>;
    if (typeof candidate.helperPid !== "number" || !Array.isArray(candidate.bundleIds)) return [];
    state = { helperPid: candidate.helperPid, bundleIds: candidate.bundleIds };
  } catch {
    return [];
  }
  const currentHelperPid = readCameraHelperPid(udid);
  if (currentHelperPid === null || state.helperPid !== currentHelperPid) return [];
  return state.bundleIds.filter((bundleId): bundleId is string => typeof bundleId === "string");
}

export async function readCameraStatus(udid: string): Promise<CameraStatusReply> {
  if (!isCameraHelperAlive(udid)) return { udid, alive: false };

  const helperPid = readCameraHelperPid(udid);
  const bundleIds = readInjectedCameraBundles(udid);
  try {
    const reply = await sendCameraHelperCommand(udid, { action: "status" });
    return { ...reply, udid, alive: true, helperPid, bundleIds };
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
