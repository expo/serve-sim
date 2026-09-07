import { existsSync, statSync } from "fs";
import { createServer } from "net";
import { join } from "path";
import type { Subprocess } from "bun";
import { assertHostModules, GUEST_PATH, guestPkgPath, SSH_OPTS, type TartGuest } from "./guest";
import { detectTartBridgeIPv6Prefix } from "./ice-candidates";
import { startPreviewProxy, type PreviewProxy } from "./preview-proxy";

const PREVIEW_PORT = Number(process.env.PORT) || 3200;
export const GUEST_NATIVE_ROOT = "/tmp/serve-sim-dist";

export type FileStamp = { size: number; mtimeSec: number };

export function guestNativeAddonPath(): string {
  return `${GUEST_NATIVE_ROOT}/native/serve-sim-native.node`;
}

export function guestFrameworkPath(): string {
  return `${GUEST_NATIVE_ROOT}/bin/LiveKitWebRTC.framework`;
}

export function parseGuestStat(stdout: string): FileStamp | null {
  const match = /^(\d+) (\d+)$/.exec(stdout.trim());
  if (!match) return null;
  const size = Number(match[1]);
  const mtimeSec = Number(match[2]);
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(mtimeSec)) return null;
  return { size, mtimeSec };
}

export function hostFileStamp(path: string): FileStamp {
  const stat = statSync(path);
  return { size: stat.size, mtimeSec: Math.floor(stat.mtimeMs / 1000) };
}

export function shouldCopyFile(host: FileStamp, guest: FileStamp | null): boolean {
  if (guest == null) return true;
  return host.size !== guest.size || host.mtimeSec !== guest.mtimeSec;
}

export function guestHealthArgs(port: number): string[] {
  return ["curl", "-sf", "--max-time", "2", `http://127.0.0.1:${port}/healthz`];
}

export function guestPreviewScript(share: string, port: number): string {
  const transport = process.env.SERVE_SIM_TRANSPORT ?? "";
  const codec = process.env.SERVE_SIM_WEBRTC_CODEC ?? "";
  const debug = process.env.SERVE_SIM_WEBRTC_DEBUG ?? "";
  const native = process.env.SERVE_SIM_NATIVE ?? "";
  const hostEncoder = process.env.SERVE_SIM_HOST_ENCODER ?? "";
  const hostEncoderHost = process.env.SERVE_SIM_HOST_ENCODER_HOST ?? "";
  const hostEncoderPort = process.env.SERVE_SIM_HOST_ENCODER_PORT ?? "";
  return `${GUEST_PATH}
set -euo pipefail
cd ${JSON.stringify(share)}
export PORT=${port}
${transport ? `export SERVE_SIM_TRANSPORT=${JSON.stringify(transport)}` : ""}
${codec ? `export SERVE_SIM_WEBRTC_CODEC=${JSON.stringify(codec)}` : ""}
${debug ? `export SERVE_SIM_WEBRTC_DEBUG=${JSON.stringify(debug)}` : ""}
${native ? `export SERVE_SIM_NATIVE=${JSON.stringify(native)}` : ""}
${hostEncoder ? `export SERVE_SIM_HOST_ENCODER=${JSON.stringify(hostEncoder)}` : ""}
${hostEncoderHost ? `export SERVE_SIM_HOST_ENCODER_HOST=${JSON.stringify(hostEncoderHost)}` : ""}
${hostEncoderPort ? `export SERVE_SIM_HOST_ENCODER_PORT=${JSON.stringify(hostEncoderPort)}` : ""}
exec bun run dev.ts
`;
}

async function waitGuestHealth(
  guest: TartGuest,
  port: number,
  serve: Subprocess,
  stopped: () => boolean,
  tries = 240,
): Promise<void> {
  const curl = guestHealthArgs(port);
  for (let i = 0; i < tries; i++) {
    if (stopped()) throw new Error("interrupted");
    if (!running(serve)) throw new Error(`guest serve-sim exited (${exitReason(serve)})`);
    if (await guest.sshOk(curl)) return;
    if (i > 0 && i % 20 === 0) console.log("waiting for serve-sim...");
    await Bun.sleep(500);
  }
  throw new Error(`serve-sim did not come up at http://127.0.0.1:${port}/healthz`);
}

async function waitOk(
  url: string,
  serve: Subprocess,
  tunnel: Subprocess,
  stopped: () => boolean,
  tries = 240,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (stopped()) throw new Error("interrupted");
    if (!running(tunnel)) throw new Error(`ssh tunnel exited (${exitReason(tunnel)})`);
    if (!running(serve)) throw new Error(`guest serve-sim exited (${exitReason(serve)})`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    if (i > 0 && i % 20 === 0) console.log("waiting for serve-sim...");
    await Bun.sleep(500);
  }
  throw new Error(`serve-sim did not come up at ${url}`);
}

async function guestFileStamp(guest: TartGuest, path: string): Promise<FileStamp | null> {
  return parseGuestStat(await guest.ssh(`stat -f '%z %m' ${JSON.stringify(path)} 2>/dev/null || true`));
}

async function scpToGuest(args: string[], label: string): Promise<void> {
  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(label);
}

async function syncGuestNative(guest: TartGuest, native: string, framework: string): Promise<void> {
  const guestNative = guestNativeAddonPath();
  const guestFramework = guestFrameworkPath();
  const target = guest.sshTarget();
  await guest.ssh(`mkdir -p ${GUEST_NATIVE_ROOT}/native ${GUEST_NATIVE_ROOT}/bin`);

  if (shouldCopyFile(hostFileStamp(native), await guestFileStamp(guest, guestNative))) {
    await scpToGuest(
      ["scp", "-p", ...SSH_OPTS, native, `${target}:${guestNative}`],
      `scp ${native} to ${guestNative} failed`,
    );
  }

  const guestBinary = `${guestFramework}/LiveKitWebRTC`;
  if (shouldCopyFile(hostFileStamp(join(framework, "LiveKitWebRTC")), await guestFileStamp(guest, guestBinary))) {
    await guest.ssh(`rm -rf ${guestFramework}`);
    await scpToGuest(
      ["scp", "-p", "-r", ...SSH_OPTS, framework, `${target}:${GUEST_NATIVE_ROOT}/bin/`],
      `scp ${framework} to ${GUEST_NATIVE_ROOT}/bin failed`,
    );
  }
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

function running(proc: Subprocess): boolean {
  return proc.exitCode == null && proc.signalCode == null;
}

function exitReason(proc: Subprocess): string {
  return proc.signalCode ?? `code ${proc.exitCode}`;
}

function stop(proc: Subprocess, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    proc.kill(signal);
  } catch {}
}

export async function waitGone(serve: Subprocess, tunnel: Subprocess, ms = 2000): Promise<void> {
  const done = Promise.allSettled([serve.exited, tunnel.exited]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([done, grace]);
  clearTimeout(timer);
  if (running(serve)) stop(serve, "SIGKILL");
  if (running(tunnel)) stop(tunnel, "SIGKILL");
  await done;
}

export function allocPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("could not allocate port")));
        return;
      }
      const port = addr.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
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
  const framework = join(guest.config.pkgDir, "dist", "bin", "LiveKitWebRTC.framework");
  if (!existsSync(native)) {
    throw new Error(`${native} is missing. Run bun run build.`);
  }
  if (!existsSync(join(framework, "LiveKitWebRTC"))) {
    throw new Error(`${framework} is missing. Run bun run build.`);
  }
  assertHostModules(guest.config);
  await assertPortFree(port);
  await guest.ssh(`lsof -ti tcp:${port} | xargs kill -TERM 2>/dev/null || true`);
  const guestNative = guestNativeAddonPath();
  await syncGuestNative(guest, native, framework);
  process.env.SERVE_SIM_NATIVE = guestNative;

  const serve = guest.sshSpawn(guestPreviewScript(share, port));
  let tunnel: Subprocess | undefined;
  let proxy: PreviewProxy | undefined;
  const shutdown = () => {
    stop(serve);
    if (tunnel) stop(tunnel);
    void proxy?.close();
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
    const ipv6Prefix = detectTartBridgeIPv6Prefix();
    if (ipv6Prefix) {
      console.log(`[tart-dev] WebRTC ICE pin ${ipv6Prefix}::/64 (Tart bridge, no STUN)`);
    }
    await waitGuestHealth(guest, port, serve, () => interrupted);
    const tunnelPort = await allocPort();
    tunnel = guest.tunnel(tunnelPort, port);
    proxy = await startPreviewProxy(port, tunnelPort, { ipv6Prefix });
    await waitOk(url + "/healthz", serve, tunnel, () => interrupted);
    await startDevice(url, udid);
    console.log(`\n  ${url}\n`);
    const code = await Promise.race([serve.exited, tunnel.exited]);
    if (!interrupted) process.exitCode = code ?? 1;
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    shutdown();
    if (tunnel) await waitGone(serve, tunnel);
    else {
      if (running(serve)) stop(serve, "SIGKILL");
      await serve.exited;
    }
  }
}
