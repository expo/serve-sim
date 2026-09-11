import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { stateDir } from "./state";

const LOCK_TIMEOUT_MS = 10_000;
export const LOCK_POLL_MS = 50;

function lockFile(udid: string): string {
  return join(stateDir(), `launch-${udid}.lock`);
}

function lockHolderIsGone(path: string): boolean {
  let contents: string;
  try {
    contents = readFileSync(path, "utf-8").trim();
  } catch {
    return true;
  }
  // Empty means another process created the file and has not written its pid
  // yet. That is held, not stale.
  if (contents === "") return false;
  const pid = Number(contents);
  if (!Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

export async function withLaunchStateLock<T>(udid: string, fn: () => Promise<T>): Promise<T> {
  if (!existsSync(stateDir())) mkdirSync(stateDir(), { recursive: true });
  const path = lockFile(udid);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | undefined;

  while (fd === undefined) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting to update the launch state for ${udid}. Another serve-sim command ` +
          `is holding ${path}. Wait for it to finish, or remove that file if nothing is running.`,
      );
    }
    try {
      fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid));
    } catch {
      if (lockHolderIsGone(path)) {
        try { unlinkSync(path); } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  try {
    return await fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(path); } catch {}
  }
}

