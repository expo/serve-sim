import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import net from "net";

const HELPER_PATH = join(import.meta.dir, "../../dist/simmic/serve-sim-mic-helper");

// Mirrors Sources/SimMicInjector/include/SimMicShared.h.
const SIMMIC_MAGIC = 0x534d4931;
const SAMPLE_RATE = 48_000;
const CAPACITY_FRAMES = SAMPLE_RATE * 4;
const HEADER_BYTES = 64;
const REGION_BYTES = HEADER_BYTES + CAPACITY_FRAMES * 4;

function helperReady(): boolean {
  try {
    return statSync(HELPER_PATH).isFile();
  } catch {
    return false;
  }
}

const shouldRun = process.platform === "darwin" && helperReady();

interface Region {
  view: DataView;
  samples: Float32Array;
  close(): void;
}

async function openRegion(name: string): Promise<Region | null> {
  const { dlopen, FFIType, toArrayBuffer } = await import("bun:ffi");
  const sys = dlopen("libSystem.dylib", {
    shm_open: { args: [FFIType.cstring, FFIType.i32, FFIType.u16], returns: FFIType.i32 },
    mmap: {
      args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i64],
      returns: FFIType.ptr,
    },
    munmap: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  });
  const fd = Number(sys.symbols.shm_open(Buffer.from(`${name}\0`) as never, 0, 0));
  if (fd < 0) return null;
  // PROT_READ = 1, MAP_SHARED = 1.
  const ptr = sys.symbols.mmap(null, BigInt(REGION_BYTES) as never, 1, 1, fd, 0n as never);
  if (!ptr) {
    sys.symbols.close(fd);
    return null;
  }
  const buffer = toArrayBuffer(ptr as never, 0, REGION_BYTES);
  return {
    view: new DataView(buffer),
    samples: new Float32Array(buffer, HEADER_BYTES, CAPACITY_FRAMES),
    close() {
      sys.symbols.munmap(ptr as never, BigInt(REGION_BYTES) as never);
      sys.symbols.close(fd);
    },
  };
}

function header(region: Region) {
  const v = region.view;
  return {
    magic: v.getUint32(0, true),
    version: v.getUint32(4, true),
    sampleRate: v.getUint32(8, true),
    capacityFrames: v.getUint32(12, true),
    sessionId: v.getBigUint64(16, true),
    writeFrames: Number(v.getBigUint64(24, true)),
    clipStart: Number(v.getBigUint64(32, true)),
    clipEnd: Number(v.getBigUint64(40, true)),
    idleMode: v.getUint32(48, true),
  };
}

function rms(region: Region, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) {
    const s = region.samples[i % CAPACITY_FRAMES]!;
    sum += s * s;
  }
  return Math.sqrt(sum / Math.max(1, end - start));
}

/** 16-bit PCM WAV of a sine wave, so decoding and resampling both run. */
function writeSineWav(path: string, opts: { seconds: number; rate: number; channels: number }) {
  const frames = Math.round(opts.seconds * opts.rate);
  const data = Buffer.alloc(frames * opts.channels * 2);
  for (let f = 0; f < frames; f++) {
    const v = Math.round(0.5 * Math.sin((2 * Math.PI * 440 * f) / opts.rate) * 32767);
    for (let c = 0; c < opts.channels; c++) data.writeInt16LE(v, (f * opts.channels + c) * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(opts.channels, 22);
  h.writeUInt32LE(opts.rate, 24);
  h.writeUInt32LE(opts.rate * opts.channels * 2, 28);
  h.writeUInt16LE(opts.channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}

function send(socketPath: string, cmd: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socketPath);
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
      c.end();
    });
    c.on("error", reject);
    c.write(JSON.stringify(cmd) + "\n");
    setTimeout(() => { c.destroy(); reject(new Error("timeout")); }, 5000).unref();
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe.skipIf(!shouldRun)("SimMicHelper", () => {
  const tag = `${process.pid.toString(36)}${Date.now().toString(36)}`.slice(-10);
  const shmName = `/ssmic-tst-${tag}`;
  const socketPath = `/tmp/ssmic-tst-${tag}.sock`;
  const dir = mkdtempSync(join(tmpdir(), "ssmic-"));
  const shortWav = join(dir, "short.wav");
  const longWav = join(dir, "long.wav");
  let helper: ChildProcess | undefined;
  let region: Region | null = null;
  let stderr = "";

  beforeAll(async () => {
    writeSineWav(shortWav, { seconds: 0.5, rate: 44_100, channels: 2 });
    writeSineWav(longWav, { seconds: 3, rate: 22_050, channels: 1 });
    helper = spawn(HELPER_PATH, ["--shm", shmName, "--socket", socketPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    helper.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    if (!(await waitFor(() => existsSync(socketPath), 5000))) {
      throw new Error(`helper never bound ${socketPath}\n${stderr.slice(0, 600)}`);
    }
    region = await openRegion(shmName);
  }, 10_000);

  afterAll(() => {
    region?.close();
    try { helper?.kill("SIGTERM"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  test("publishes the documented header", () => {
    expect(region).not.toBeNull();
    const h = header(region!);
    expect(h.magic).toBe(SIMMIC_MAGIC);
    expect(h.version).toBe(1);
    expect(h.sampleRate).toBe(SAMPLE_RATE);
    expect(h.capacityFrames).toBe(CAPACITY_FRAMES);
    expect(h.sessionId).not.toBe(0n);
    expect(h.clipEnd).toBe(0);
    expect(h.idleMode).toBe(0);
  });

  test("streams frames at the sample rate while idle", async () => {
    const start = header(region!).writeFrames;
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 500));
    const frames = header(region!).writeFrames - start;
    const expected = ((Date.now() - t0) / 1000) * SAMPLE_RATE;
    expect(frames).toBeGreaterThan(expected * 0.8);
    expect(frames).toBeLessThan(expected * 1.2);
  });

  test("plays a file into the clip range, resampled to 48 kHz mono", async () => {
    const before = header(region!).writeFrames;
    const reply = await send(socketPath, { action: "play", path: shortWav });
    expect(reply.ok).toBe(true);
    expect(reply.durationMs).toBeCloseTo(500, -1);

    const h = header(region!);
    expect(h.clipStart).toBeGreaterThanOrEqual(before);
    expect(h.clipEnd - h.clipStart).toBeCloseTo(SAMPLE_RATE / 2, -1);
    expect((await send(socketPath, { action: "status" })).playing).toBe(true);

    expect(await waitFor(() => header(region!).writeFrames > h.clipEnd, 2000)).toBe(true);
    // Amplitude 0.5 sine → RMS 0.5/√2.
    expect(rms(region!, h.clipStart + 100, h.clipEnd - 100)).toBeCloseTo(0.3536, 2);
    expect(rms(region!, h.clipEnd + 10, h.clipEnd + 1000)).toBe(0);

    expect(await waitFor(async () => !(await send(socketPath, { action: "status" })).playing, 2000)).toBe(true);
  });

  test("pre-roll delays the clip start", async () => {
    const before = header(region!).writeFrames;
    const reply = await send(socketPath, { action: "play", path: shortWav, preRollMs: 250 });
    expect(reply.ok).toBe(true);
    expect(header(region!).clipStart - before).toBeGreaterThanOrEqual(SAMPLE_RATE / 4);
    await send(socketPath, { action: "stop" });
  });

  test("stop empties the clip range at once", async () => {
    await send(socketPath, { action: "play", path: longWav });
    expect(header(region!).clipEnd).toBeGreaterThan(0);
    const reply = await send(socketPath, { action: "stop" });
    expect(reply.ok).toBe(true);
    expect(header(region!).clipEnd).toBe(0);
    expect((await send(socketPath, { action: "status" })).playing).toBe(false);
  });

  test("setIdle switches between silence and passthrough", async () => {
    expect((await send(socketPath, { action: "setIdle", mode: "passthrough" })).ok).toBe(true);
    expect(header(region!).idleMode).toBe(1);
    expect((await send(socketPath, { action: "status" })).idle).toBe("passthrough");
    expect((await send(socketPath, { action: "setIdle", mode: "loud" })).ok).toBe(false);
    expect((await send(socketPath, { action: "setIdle", mode: "silence" })).ok).toBe(true);
    expect(header(region!).idleMode).toBe(0);
  });

  test("rejects files it cannot decode", async () => {
    const reply = await send(socketPath, { action: "play", path: join(dir, "missing.mp3") });
    expect(reply.ok).toBe(false);
    expect(typeof reply.error).toBe("string");
  });

  test("shutdown removes the socket and the shm name", async () => {
    const exited = new Promise((resolve) => helper!.once("exit", resolve));
    await send(socketPath, { action: "shutdown" }).catch(() => {});
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    expect(existsSync(socketPath)).toBe(false);
    expect(await openRegion(shmName)).toBeNull();
  });
});
