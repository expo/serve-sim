import { existsSync } from "fs";
import net from "net";

import { cameraHelperSocketFile } from "./camera-helper";

const HANDSHAKE_TIMEOUT_MS = 3_000;
const IDLE_TIMEOUT_MS = 10_000;
const MAX_HANDSHAKE_BYTES = 4096;
export const MAX_CAMERA_FRAME_BYTES = 8 * 1024 * 1024;

interface FrameStream {
  udid: string;
  owner: symbol;
  socket: net.Socket;
  ready: boolean;
  draining: boolean;
  idle: ReturnType<typeof setTimeout>;
  handshake: ReturnType<typeof setTimeout>;
}

const streams = new Map<string, FrameStream>();
const claims = new Map<string, symbol>();

function drop(stream: FrameStream): void {
  if (streams.get(stream.udid) === stream) streams.delete(stream.udid);
  clearTimeout(stream.idle);
  clearTimeout(stream.handshake);
  stream.socket.destroy();
}

function openStream(udid: string, owner: symbol): FrameStream | null {
  const socketPath = cameraHelperSocketFile(udid);
  if (!existsSync(socketPath)) return null;

  const socket = net.createConnection(socketPath);
  const stream: FrameStream = {
    udid,
    owner,
    socket,
    ready: false,
    draining: false,
    idle: setTimeout(() => drop(stream), IDLE_TIMEOUT_MS),
    handshake: setTimeout(() => drop(stream), HANDSHAKE_TIMEOUT_MS),
  };
  stream.idle.unref();
  stream.handshake.unref();
  streams.set(udid, stream);

  socket.once("connect", () => {
    socket.write(`${JSON.stringify({ action: "frames" })}\n`);
  });
  let handshake = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    if (stream.ready) return;
    if (handshake.length + chunk.length > MAX_HANDSHAKE_BYTES) {
      drop(stream);
      return;
    }
    handshake = Buffer.concat([handshake, chunk]);
    const newline = handshake.indexOf(10);
    if (newline < 0) return;
    let reply: unknown;
    try {
      reply = JSON.parse(handshake.toString("utf8", 0, newline));
    } catch {
      drop(stream);
      return;
    }
    if (reply && typeof reply === "object" && "ok" in reply && reply.ok === true) {
      clearTimeout(stream.handshake);
      handshake = Buffer.alloc(0);
      stream.ready = true;
    } else {
      drop(stream);
    }
  });
  socket.on("drain", () => {
    stream.draining = false;
  });
  socket.on("error", () => drop(stream));
  socket.on("close", () => drop(stream));
  return stream;
}

export function claimCameraFrameStream(udid: string, owner: symbol): void {
  closeCameraFrameStream(udid);
  claims.set(udid, owner);
}

export function closeCameraFrameStream(udid: string, owner?: symbol): void {
  if (owner !== undefined && claims.get(udid) !== owner) return;
  claims.delete(udid);
  const stream = streams.get(udid);
  if (stream) drop(stream);
}

export function closeCameraFrameStreams(owner: symbol): void {
  for (const [udid, claimant] of claims) {
    if (claimant === owner) closeCameraFrameStream(udid, owner);
  }
}

export function ownsCameraFrameStream(udid: string, owner: symbol): boolean {
  return claims.get(udid) === owner;
}

export function writeCameraFrame(udid: string, frame: Buffer, owner: symbol): boolean {
  if (!ownsCameraFrameStream(udid, owner) || frame.length === 0 || frame.length > MAX_CAMERA_FRAME_BYTES) return false;
  const stream = streams.get(udid) ?? openStream(udid, owner);
  if (!stream) return false;

  clearTimeout(stream.idle);
  const current = stream;
  stream.idle = setTimeout(() => drop(current), IDLE_TIMEOUT_MS);
  stream.idle.unref();

  // Keep at most one frame in the socket's write queue.
  if (!stream.ready || stream.draining) return false;
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(frame.length, 0);
  stream.draining = !stream.socket.write(Buffer.concat([header, frame]));
  return true;
}
