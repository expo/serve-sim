import { existsSync } from "fs";
import { createServer } from "net";
import { join } from "path";
import type { Subprocess } from "bun";
import { GUEST_PATH, guestPkgPath, type TartGuest } from "./guest";

const PREVIEW_PORT = Number(process.env.PORT) || 3200;

export function guestPreviewScript(share: string, port: number): string {
  return `${GUEST_PATH}
set -euo pipefail
cd ${JSON.stringify(share)}
if [[ ! -d node_modules ]]; then
  bun install
fi
export PORT=${port}
exec bun run dev.ts
`;
}

async function waitOk(url: string, serve: Subprocess, tunnel: Subprocess, tries = 240): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (tunnel.exitCode != null) throw new Error(`ssh tunnel exited ${tunnel.exitCode}`);
    if (serve.exitCode != null) throw new Error(`guest serve-sim exited ${serve.exitCode}`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    if (i > 0 && i % 20 === 0) console.log("waiting for serve-sim...");
    await Bun.sleep(500);
  }
  throw new Error(`serve-sim did not come up at ${url}`);
}

async function startDevice(url: string, udid: string): Promise<void> {
  const res = await fetch(`${url}/grid/api/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ udid }),
  });
  if (!res.ok) {
    throw new Error(`grid start failed (${res.status}): ${await res.text()}`);
  }
}

function stop(proc: Subprocess): void {
  try {
    proc.kill("SIGTERM");
  } catch {}
}

export function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", () => {
      reject(new Error(`port ${port} is already in use`));
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve());
    });
  });
}

export async function runDev(guest: TartGuest, udid: string): Promise<void> {
  const share = guestPkgPath(guest.config);
  const port = PREVIEW_PORT;
  const url = `http://localhost:${port}`;
  const native = join(guest.config.pkgDir, "dist", "native", "serve-sim-native.node");
  if (!existsSync(native)) {
    throw new Error(`${native} is missing. Run bun run build.`);
  }
  await assertPortFree(port);
  await guest.ssh(`lsof -ti tcp:${port} | xargs kill -TERM 2>/dev/null || true`);

  const serve = guest.sshSpawn(guestPreviewScript(share, port));
  const tunnel = guest.tunnel(port, port);
  const shutdown = () => {
    stop(serve);
    stop(tunnel);
  };
  let interrupted = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      interrupted = true;
      process.exitCode = 0;
      shutdown();
    });
  }

  try {
    await waitOk(url + "/healthz", serve, tunnel);
    await startDevice(url, udid);
    console.log(`\n  ${url}\n`);
    const code = await Promise.race([serve.exited, tunnel.exited]);
    if (!interrupted) process.exitCode = code ?? 1;
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    shutdown();
    await Promise.allSettled([serve.exited, tunnel.exited]);
  }
}
