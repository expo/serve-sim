/**
 * In-process device session — the replacement for the spawned serve-sim-bin
 * helper. One session per booted simulator owns a NativeCapture + NativeHid and
 * serves the same wire endpoints the helper's HTTP server did, byte-for-byte:
 *
 *   /stream.mjpeg  multipart/x-mixed-replace JPEG fan-out (?raw=1 → octet-stream)
 *   /stream.avcc   length-prefixed AVCC envelopes (seed + decoder config replay)
 *   /ws            binary HID input protocol ([tag][JSON]) → NativeHid
 *   /config        { width, height, orientation }
 *   /health        { status: "ok" }
 *   /ax            axe-shaped accessibility JSON (one-shot)
 *   /foreground    { bundleId, pid }
 *
 * Replaces the helper's HTTP/client layer; the framing here mirrors the
 * original byte-for-byte so the existing browser client is unchanged.
 */
import type { IncomingMessage, ServerResponse } from "http";
import {
  NativeCapture,
  NativeHid,
  Orientation,
  axDescribeAsync,
  axFrontmostAsync,
  type MjpegFrame,
} from "./native";

/**
 * Minimal WebSocket surface the HID input channel needs. Satisfied by both the
 * `ws` library and the raw-socket adapter the middleware uses under Bun (where
 * `ws`'s server-side handshake doesn't flush). Messages arrive as binary
 * `[tag][JSON]` frames; `send` writes a binary frame.
 */
export interface HidSocket {
  send(data: Buffer): void;
  on(event: "message", cb: (data: Buffer) => void): void;
  on(event: "close" | "error", cb: () => void): void;
  close(): void;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// AVCC seed tag (StreamFormat.AVCCEnvelope.seedTag). description/keyframe/delta
// envelopes are framed natively; only the on-connect JPEG seed is built here.
const AVCC_SEED_TAG = 0x04;

// WS server→client screen-config push (ClientManager.wsMsgConfig).
const WS_MSG_CONFIG = 0x82;

const MJPEG_TRAILER = Buffer.from("\r\n", "ascii");

function mjpegHeader(jpegLength: number): Buffer {
  return Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegLength}\r\n\r\n`, "ascii");
}

function avccSeed(jpeg: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(5 + jpeg.length);
  out.writeUInt32BE(jpeg.length + 1, 0); // length covers the tag byte + payload
  out[4] = AVCC_SEED_TAG;
  out.set(jpeg, 5);
  return out;
}

const ORIENTATION_BY_NAME: Record<string, number> = {
  portrait: Orientation.portrait,
  portrait_upside_down: Orientation.portraitUpsideDown,
  landscape_left: Orientation.landscapeLeft,
  landscape_right: Orientation.landscapeRight,
};

function waitForDrain(res: ServerResponse): Promise<void> {
  if (res.writableEnded || res.destroyed || !res.writableNeedDrain) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      res.off("drain", done);
      res.off("close", done);
      res.off("error", done);
    };
    res.once("drain", done);
    res.once("close", done);
    res.once("error", done);
  });
}

export class DeviceSession {
  private readonly capture: NativeCapture;
  private readonly hid: NativeHid;
  private unsubscribeMjpeg?: () => void;
  private phase: "unstarted" | "running" | "stopped" = "unstarted";

  private width = 0;
  private height = 0;
  private orientation = "portrait";

  private latestJpegBuffer: Buffer | null = null;
  private latestJpegLength = 0;
  private readonly hidSockets = new Set<HidSocket>();

  constructor(public readonly udid: string) {
    this.hid = new NativeHid(udid);
    this.capture = new NativeCapture(udid);
  }

  /** Begin capture. Throws if the device isn't booted. Idempotent. */
  start(): void {
    if (this.phase !== "unstarted") return;
    this.capture.start();
    void (async () => {
      const unsubscribe = await this.capture.subscribeMjpeg((frame) => this.onSharedMjpegFrame(frame));
      if (this.phase === "running") { // only if someone hasn't already stopped the capture
        this.unsubscribeMjpeg = unsubscribe;
      } else {
        unsubscribe();
      }
    })();
    this.phase = "running";
  }

  close(): void {
    if (this.phase !== "running") return;
    for (const ws of this.hidSockets) ws.close();
    this.unsubscribeMjpeg?.();
    this.hidSockets.clear();
    this.capture.stop();
    this.phase = "stopped";
  }

  // ── Frame handling ───────────────────────────────────────────────────────

  private async onSharedMjpegFrame(frame: MjpegFrame): Promise<void> {
    const { width, height, data: jpeg } = frame;

    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.broadcastConfig();
    }

    if (!this.latestJpegBuffer || this.latestJpegBuffer.length < jpeg.length) {
      const currentCapacity = this.latestJpegBuffer?.length ?? 0;
      this.latestJpegBuffer = Buffer.allocUnsafe(Math.max(jpeg.length, currentCapacity * 2));
    }
    this.latestJpegBuffer.set(jpeg, 0);
    this.latestJpegLength = jpeg.length;
  }

  private latestJpeg(): Buffer | null {
    if (!this.latestJpegBuffer) return null;
    return this.latestJpegBuffer.subarray(0, this.latestJpegLength);
  }

  /** Write a multipart JPEG part (header + shared frame + boundary) without copying the JPEG. */
  private writeMjpegFrame(res: ServerResponse, jpeg: Uint8Array): void {
    res.write(mjpegHeader(jpeg.length));
    res.write(jpeg);
    res.write(MJPEG_TRAILER);
  }

  // ── HTTP handlers ────────────────────────────────────────────────────────

  handleMjpeg(req: IncomingMessage, res: ServerResponse): void {
    const raw = new URL(req.url ?? "", "http://x").searchParams.get("raw") === "1";
    res.writeHead(200, {
      "Content-Type": raw ? "application/octet-stream" : "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      ...CORS,
    });

    void (async () => {
      const latestJpeg = this.latestJpeg();
      if (latestJpeg) this.writeMjpegFrame(res, latestJpeg); // paint immediately
      const unsubscribe = await this.capture.subscribeMjpeg(async (frame) => {
        await waitForDrain(res);
        this.writeMjpegFrame(res, frame.data);
      });
      if (res.writableEnded) unsubscribe();
      res.on("close", unsubscribe);
      res.on("error", unsubscribe);
    })();
  }

  handleAvcc(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      ...CORS,
    });

    void (async () => {
      // Seed with the current screen; the per-client native AVCC subscription
      // starts with its own decoder config and keyframe.
      const latestJpeg = this.latestJpeg();
      if (latestJpeg) res.write(avccSeed(latestJpeg));

      const unsubscribe = await this.capture.subscribeAvcc(async (frame) => {
        await waitForDrain(res);
        res.write(frame.data);
      });
      if (res.writableEnded) unsubscribe();
      res.on("close", unsubscribe);
      res.on("error", unsubscribe);
    })();
  }

  handleConfig(_req: IncomingMessage, res: ServerResponse): void {
    this.sendJson(res, 200, this.screenConfig());
  }

  handleHealth(_req: IncomingMessage, res: ServerResponse): void {
    this.sendJson(res, 200, { status: "ok" });
  }

  handleAx(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    return this.serveAxJson(res, () => axDescribeAsync(this.udid), "ax_unavailable");
  }

  handleForeground(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    return this.serveAxJson(res, () => axFrontmostAsync(this.udid), "foreground_unavailable");
  }

  /** Run a native AX probe and stream its JSON, or 503 with `errorCode` if it's not ready. */
  private async serveAxJson(res: ServerResponse, probe: () => Promise<string>, errorCode: string): Promise<void> {
    try {
      const json = await probe();
      if (res.writableEnded) return;
      this.sendJsonString(res, 200, json);
    } catch (err) {
      if (res.writableEnded) return;
      this.sendJson(res, 503, {
        error: errorCode,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── HID WebSocket ────────────────────────────────────────────────────────

  attachHidSocket(ws: HidSocket): void {
    this.hidSockets.add(ws);
    const cfg = this.configFrame();
    if (cfg) ws.send(cfg); // seed dimensions/orientation, replacing the old poll
    ws.on("message", (data: Buffer) => this.handleHidMessage(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    ws.on("close", () => this.hidSockets.delete(ws));
    ws.on("error", () => this.hidSockets.delete(ws));
  }

  private async handleHidMessage(data: Buffer): Promise<void> {
    if (data.length < 1) return;
    const tag = data[0];
    const body = data.length > 1 ? data.subarray(1) : null;
    const json = <T>(): T | null => {
      if (!body) return null;
      try {
        return JSON.parse(body.toString("utf8")) as T;
      } catch {
        return null;
      }
    };
    const W = this.width;
    const H = this.height;

    switch (tag) {
      case 0x03: {
        const m = json<{ type: string; x: number; y: number; edge?: number }>();
        if (m) this.hid.touch(m.type as "begin" | "move" | "end", m.x, m.y, W, H, m.edge ?? 0);
        break;
      }
      case 0x04: {
        const m = json<{ button: string; page?: number; usage?: number; phase?: string }>();
        if (!m) break;
        if (m.page != null && m.usage != null) {
          this.hid.buttonHid(m.page, m.usage, (m.phase as "down" | "up" | "press") ?? "press");
        } else {
          this.hid.button(m.button);
        }
        break;
      }
      case 0x05: {
        const m = json<{ type: string; x1: number; y1: number; x2: number; y2: number }>();
        if (m) this.hid.multiTouch(m.type as "begin" | "move" | "end", m.x1, m.y1, m.x2, m.y2, W, H);
        break;
      }
      case 0x06: {
        const m = json<{ type: string; usage: number }>();
        if (m) this.hid.key(m.type as "down" | "up", m.usage);
        break;
      }
      case 0x07: {
        const m = json<{ orientation: string }>();
        if (!m) break;
        const value = ORIENTATION_BY_NAME[m.orientation];
        if (value != null && await this.hid.orientation(value)) {
          if (m.orientation !== this.orientation) {
            this.orientation = m.orientation;
            this.broadcastConfig();
          }
        }
        break;
      }
      case 0x08: {
        const m = json<{ option: string; enabled: boolean }>();
        if (m) this.hid.caDebug(m.option, m.enabled);
        break;
      }
      case 0x09:
        this.hid.memoryWarning();
        break;
      case 0x0a: {
        const m = json<{ delta: number }>();
        if (m) this.hid.digitalCrown(m.delta);
        break;
      }
      case 0x0b: {
        // Payload deltas are a fraction of the display; scale to device pixels.
        const m = json<{ dx: number; dy: number; x?: number; y?: number }>();
        if (m) this.hid.scroll(m.dx * W, m.dy * H, W, H, m.x, m.y);
        break;
      }
      case 0x0c:
        this.hid.softwareKeyboard();
        break;
    }
  }

  // ── Config ───────────────────────────────────────────────────────────────

  screenConfig(): { width: number; height: number; orientation: string } {
    return { width: this.width, height: this.height, orientation: this.orientation };
  }

  private configFrame(): Buffer | null {
    if (this.width === 0 && this.height === 0) return null;
    return Buffer.concat([Buffer.from([WS_MSG_CONFIG]), Buffer.from(JSON.stringify(this.screenConfig()))]);
  }

  private broadcastConfig(): void {
    const frame = this.configFrame();
    if (!frame) return;
    for (const ws of this.hidSockets) ws.send(frame);
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    this.sendJsonString(res, status, JSON.stringify(body));
  }

  private sendJsonString(res: ServerResponse, status: number, json: string): void {
    const buf = Buffer.from(json, "utf8");
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store",
      "Content-Length": String(buf.length),
      ...CORS,
    });
    res.end(buf);
  }
}

// ── Registry ─────────────────────────────────────────────────────────────

const sessions = new Map<string, DeviceSession>();

/**
 * Get (lazily creating + starting) the in-process session for `udid`. Throws if
 * the device isn't booted. The session lives until `closeDeviceSession`.
 */
export function getDeviceSession(udid: string): DeviceSession {
  let session = sessions.get(udid);
  if (!session) {
    session = new DeviceSession(udid);
    try {
      session.start();
    } catch (err) {
      session.close();
      throw err;
    }
    sessions.set(udid, session);
  }
  return session;
}

export function closeDeviceSession(udid: string): void {
  const session = sessions.get(udid);
  if (session) {
    session.close();
    sessions.delete(udid);
  }
}
