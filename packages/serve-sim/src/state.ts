import { tmpdir } from "os";
import { join } from "path";
import { readdirSync, mkdirSync, writeFileSync, renameSync } from "fs";

/** Directory where serve-sim stores runtime state. */
export const STATE_DIR = join(tmpdir(), "serve-sim");

/** Path to the serve-sim server state file (JSON with pid, port, URLs).
 *  @deprecated Use `stateFileForDevice(udid)` for multi-device support. Kept for backward compat. */
export const STATE_FILE = join(STATE_DIR, "server.json");

/** Per-device state file: `/tmp/serve-sim/server-{udid}.json` */
export function stateFileForDevice(udid: string): string {
  return join(STATE_DIR, `server-${udid}.json`);
}

export type ServeSimTransport = "http" | "webrtc";
export type ServeSimHttpCodec = "auto" | "mjpeg" | "h264";
export type ServeSimWebRTCCodec = "vp8" | "vp9" | "h264";
export type ServeSimIceServer = { urls: string[]; username?: string; credential?: string };

export interface ServeSimStreamSettings {
  transport: ServeSimTransport;
  codec: ServeSimHttpCodec;
  streamFps: number;
  streamQuality: number;
  streamMaxDimension: number;
  h264Bitrate: number;
  h264MaxFps: number;
  webrtcCodec: ServeSimWebRTCCodec;
  webrtcIceServers?: ServeSimIceServer[];
}

export const DEFAULT_STREAM_SETTINGS: ServeSimStreamSettings = {
  transport: "http",
  codec: "auto",
  streamFps: 60,
  streamQuality: 0.7,
  streamMaxDimension: 720,
  h264Bitrate: 6_000_000,
  h264MaxFps: 60,
  webrtcCodec: "h264",
};

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function intInRange(value: unknown, fallback: number, min: number, max: number): number {
  const n = finiteNumber(value);
  if (n == null) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const n = finiteNumber(value);
  if (n == null) return fallback;
  return Math.min(max, Math.max(min, n));
}

function validIceServers(value: unknown): ServeSimIceServer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const servers = value.flatMap((entry): ServeSimIceServer[] => {
    if (!entry || typeof entry !== "object") return [];
    const urls = (entry as { urls?: unknown }).urls;
    if (!Array.isArray(urls) || !urls.every((url) => typeof url === "string")) return [];
    const username = (entry as { username?: unknown }).username;
    const credential = (entry as { credential?: unknown }).credential;
    return [{
      urls,
      ...(typeof username === "string" ? { username } : {}),
      ...(typeof credential === "string" ? { credential } : {}),
    }];
  });
  return servers.length > 0 ? servers : undefined;
}

export function normalizeStreamSettings(
  input: Partial<ServeSimStreamSettings> = {},
  fallback: ServeSimStreamSettings = DEFAULT_STREAM_SETTINGS,
): ServeSimStreamSettings {
  const transport = input.transport === "webrtc" || input.transport === "http"
    ? input.transport
    : fallback.transport;
  const codec = input.codec === "auto" || input.codec === "mjpeg" || input.codec === "h264"
    ? input.codec
    : fallback.codec;
  const webrtcCodec = input.webrtcCodec === "vp8" || input.webrtcCodec === "vp9" || input.webrtcCodec === "h264"
    ? input.webrtcCodec
    : fallback.webrtcCodec;
  return {
    transport,
    codec,
    streamFps: intInRange(input.streamFps, fallback.streamFps, 1, 120),
    streamQuality: numberInRange(input.streamQuality, fallback.streamQuality, 0.05, 1),
    streamMaxDimension: intInRange(input.streamMaxDimension, fallback.streamMaxDimension, 0, 4096),
    h264Bitrate: intInRange(input.h264Bitrate, fallback.h264Bitrate, 100_000, 50_000_000),
    h264MaxFps: intInRange(input.h264MaxFps, fallback.h264MaxFps, 1, 120),
    webrtcCodec,
    ...(validIceServers(input.webrtcIceServers) ?? fallback.webrtcIceServers
      ? { webrtcIceServers: validIceServers(input.webrtcIceServers) ?? fallback.webrtcIceServers }
      : {}),
  };
}

export function mergeStreamSettings(
  current: ServeSimStreamSettings,
  patch: Partial<ServeSimStreamSettings>,
): ServeSimStreamSettings {
  return normalizeStreamSettings({ ...current, ...patch }, current);
}

/** Runtime record for a device streamed in-process by a preview server. */
export interface ServeSimDeviceState extends Partial<ServeSimStreamSettings> {
  pid: number;
  port: number;
  device: string;
  url: string;
  streamUrl: string;
  wsUrl: string;
}

/**
 * Build the state for a device served in-process. There's no separate helper
 * port — the URLs point at the preview server's own same-origin
 * `{base}/helper/<device>/…` routes, which simMiddleware serves from a
 * NativeCapture/NativeHid DeviceSession.
 */
export function inProcessServeSimState(
  udid: string,
  port: number,
  base = "/",
  host = "127.0.0.1",
  stream?: Partial<ServeSimStreamSettings>,
): ServeSimDeviceState {
  const h = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  // Normalize to a leading-slash, no-trailing-slash prefix so a base without a
  // leading slash (e.g. "foo") still yields well-formed `…:port/foo/helper/…`.
  const trimmed = base.replace(/^\/+/, "").replace(/\/+$/, "");
  const prefix = trimmed === "" ? "" : `/${trimmed}`;
  return {
    pid: process.pid,
    port,
    device: udid,
    url: `http://${h}:${port}`,
    streamUrl: `http://${h}:${port}${prefix}/helper/${udid}/stream.mjpeg`,
    wsUrl: `ws://${h}:${port}${prefix}/helper/${udid}/ws`,
    ...normalizeStreamSettings(stream),
  };
}

/** Persist a device's state so other processes / the grid can enumerate it.
 *  Writes atomically (temp file + rename) so a concurrent reader never observes
 *  a truncated or partially-written file. */
export function writeServeSimState(state: ServeSimDeviceState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const file = stateFileForDevice(state.device);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

/** List all per-device state files in the state directory. */
export function listStateFiles(): string[] {
  try {
    return readdirSync(STATE_DIR)
      .filter((f) => f.startsWith("server-") && f.endsWith(".json"))
      .map((f) => join(STATE_DIR, f));
  } catch {
    return [];
  }
}
