import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { STATE_DIR, stateFileForDevice } from "../state";

export const UDID = "404F2659-7202-4450-8465-912BD2AB744B";
export const EXIT_0_SHIM = "#!/bin/sh\nexit 0\n";

/** Puts throwaway executables first on PATH; `restore` puts PATH back and removes them. */
export function installShims(shims: Record<string, string>): { dir: string; restore(): void } {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-shims-"));
  for (const [name, body] of Object.entries(shims)) {
    const shim = join(dir, name);
    writeFileSync(shim, body);
    chmodSync(shim, 0o755);
  }
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath ?? ""}`;
  return {
    dir,
    restore() {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function withShimsAsync(
  shims: Record<string, string>,
  run: () => Promise<void>,
): Promise<void> {
  const installed = installShims(shims);
  try {
    await run();
  } finally {
    installed.restore();
  }
}

/** The action deadline is read per call, so a test can shorten the shipped two minutes. */
export async function withActionTimeoutAsync(ms: number, run: () => Promise<void>): Promise<void> {
  const original = process.env.SERVE_SIM_ACTION_TIMEOUT_MS;
  process.env.SERVE_SIM_ACTION_TIMEOUT_MS = String(ms);
  try {
    await run();
  } finally {
    if (original === undefined) delete process.env.SERVE_SIM_ACTION_TIMEOUT_MS;
    else process.env.SERVE_SIM_ACTION_TIMEOUT_MS = original;
  }
}

/** What a serving process records about itself; ownership is read from this, never from `ps`. */
export function recordState(udid: string, pid: number, port: number): () => void {
  mkdirSync(STATE_DIR, { recursive: true });
  const file = stateFileForDevice(udid);
  writeFileSync(
    file,
    JSON.stringify({
      pid,
      port,
      device: udid,
      url: `http://127.0.0.1:${port}`,
      streamUrl: `http://127.0.0.1:${port}/stream.mjpeg`,
      wsUrl: `ws://127.0.0.1:${port}/ws`,
    }),
  );
  return () => rmSync(file, { force: true });
}
