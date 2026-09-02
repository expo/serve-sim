import { existsSync } from "fs";
import { createServer } from "net";
import { join } from "path";
import type { Subprocess } from "bun";
import { assertHostModules, GUEST_PATH, guestPkgPath, SSH_OPTS, type TartGuest } from "./guest";
import { detectTartBridgeIPv6Prefix } from "./ice-candidates";
import { startPreviewProxy, type PreviewProxy } from "./preview-proxy";

const PREVIEW_PORT = Number(process.env.PORT) || 3200;
export const GUEST_NATIVE_ROOT = "/tmp/serve-sim-dist";

export function guestNativeAddonPath(): string {
  return `${GUEST_NATIVE_ROOT}/native/serve-sim-native.node`;
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
  const target = guest.sshTarget();
  await guest.ssh(`mkdir -p ${GUEST_NATIVE_ROOT}/native ${GUEST_NATIVE_ROOT}/bin && rm -rf ${GUEST_NATIVE_ROOT}/bin/LiveKitWebRTC.framework`);
  const scpNative = Bun.spawn(["scp", ...SSH_OPTS, native, `${target}:${guestNative}`], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if ((await scpNative.exited) !== 0) {
    throw new Error(`scp ${native} to ${guestNative} failed`);
  }
  const scpFramework = Bun.spawn(["scp", "-r", ...SSH_OPTS, framework, `${target}:${GUEST_NATIVE_ROOT}/bin/`], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if ((await scpFramework.exited) !== 0) {
    throw new Error(`scp ${framework} to ${GUEST_NATIVE_ROOT}/bin failed`);
  }
  process.env.SERVE_SIM_NATIVE = guestNative;

  const serve = guest.sshSpawn(guestPreviewScript(share, port));
  const tunnelPort = await allocPort();
  const tunnel = guest.tunnel(tunnelPort, port);
  let proxy: PreviewProxy | undefined;
  const shutdown = () => {
    stop(serve);
    stop(tunnel);
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
    await waitGone(serve, tunnel);
  }
}
