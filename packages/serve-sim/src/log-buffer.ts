// One shared `simctl log stream` tail per device, feeding a bounded ring that `/logs` reads.
// The simctl child runs while someone is subscribed or a poller is calling ensure()
// (the preview drawer, every 2s). An always-on info stream stalls `/exec-ws`
// (Home, metrics) and fights the capture process for CPU.

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

// ~317 lines/sec at `--level info`, so a line cap is a poor proxy for depth.
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

const LINE_BUFFER_LIMIT = 1024 * 1024; // drop a pathological unbroken line
const RESTART_DELAY_MS = 1000;
const MAX_RESTART_DELAY_MS = 30_000;
// Pollers call ensure() every ~2s. A missed tick must not kill the child, but
// closing the drawer must not leave simctl running.
const POLL_IDLE_MS = 8_000;

export interface LogLine {
  // Cursor for `since`: log timestamps are strings and not reliably ordered.
  seq: number;
  at: number;
  raw: string;
}

// A SpringBoard line naming the app is not an app line, so read the emitter field rather
// than matching the raw text.
function emittedBy(raw: string, processName: string): boolean {
  try {
    const path = (JSON.parse(raw) as { processImagePath?: unknown }).processImagePath;
    return typeof path === "string" && path.slice(path.lastIndexOf("/") + 1) === processName;
  } catch {
    return false;
  }
}

function spawnDeviceLogStream(udid: string): ChildProcess {
  return spawn(
    "xcrun",
    ["simctl", "spawn", udid, "log", "stream", "--style", "ndjson", "--level", "info"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
}

export interface LogBufferDeps {
  spawnLogStream?: (udid: string) => ChildProcess;
  maxBytes?: number;
  restartDelayMs?: number;
  idleAfterMs?: number;
  now?: () => number;
}

type Listener = (line: LogLine) => void;

export class DeviceLogBuffer {
  private child: ChildProcess | null = null;
  private decoder = new StringDecoder("utf8");
  private partial = "";
  private dropping = false;
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private lines: LogLine[] = [];
  private head = 0;
  private bytes = 0;
  private seq = 0;
  private stopped = false;
  private readonly batchListeners = new Set<(lines: readonly LogLine[]) => void>();
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly closeListeners = new Set<() => void>();

  constructor(
    private readonly udid: string,
    private readonly deps: Required<LogBufferDeps>
  ) {}

  get byteLength(): number {
    return this.bytes;
  }

  get status(): "streaming" | "restarting" | "stopped" {
    if (this.child) return "streaming";
    return this.stopped ? "stopped" : "restarting";
  }

  get error(): string | null {
    return this.lastError;
  }

  get listenerCount(): number {
    return this.listeners.size + this.batchListeners.size;
  }

  subscribe(listener: Listener, onClosed?: () => void): () => void {
    this.listeners.add(listener);
    if (onClosed) this.closeListeners.add(onClosed);
    this.clearIdle();
    return () => {
      this.listeners.delete(listener);
      if (onClosed) this.closeListeners.delete(onClosed);
      this.releaseIfIdle();
    };
  }

  /** One callback per stdout burst so a reader can write a single SSE/WS frame. */
  subscribeBatch(listener: (lines: readonly LogLine[]) => void, onClosed?: () => void): () => void {
    this.batchListeners.add(listener);
    if (onClosed) this.closeListeners.add(onClosed);
    this.clearIdle();
    return () => {
      this.batchListeners.delete(listener);
      if (onClosed) this.closeListeners.delete(onClosed);
      this.releaseIfIdle();
    };
  }

  start(): void {
    this.stopped = false;
    if (!this.child) this.spawn();
    if (this.listenerCount === 0) this.armIdle();
    else this.clearIdle();
  }

  stop(): void {
    this.stopped = true;
    this.clearIdle();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.child?.removeAllListeners();
    this.child?.stdout?.destroy();
    this.child?.kill();
    this.child = null;
    this.partial = "";
    this.dropping = false;
    for (const onClosed of [...this.closeListeners]) {
      try {
        onClosed();
      } catch {
        // A reader that throws on teardown must not stop the others.
      }
    }
    this.closeListeners.clear();
  }

  /** Drop the simctl child when nobody is reading. The ring stays for a later `/logs`. */
  private releaseIfIdle(): void {
    if (this.listeners.size + this.batchListeners.size > 0) return;
    this.stopped = true;
    this.clearIdle();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.child?.removeAllListeners();
    this.child?.stdout?.destroy();
    this.child?.kill();
    this.child = null;
    this.partial = "";
    this.dropping = false;
  }

  /** Oldest first. */
  read({ since, limit }: { since?: number; limit?: number } = {}): LogLine[] {
    const live = this.head === 0 ? this.lines : this.lines.slice(this.head);
    let selected = since === undefined ? live : live.filter((l) => l.seq > since);
    if (limit !== undefined && selected.length > limit) {
      selected = selected.slice(selected.length - limit);
    }
    return selected === this.lines ? [...selected] : selected;
  }

  /**
   * Newest-last lines from `processName`, at or before `at`. `reason` separates "the buffer
   * does not reach back that far" from "it does, but that process logged nothing".
   */
  tailBefore({
    at,
    count,
    processName,
    maxBytes,
  }: {
    at: number;
    count: number;
    processName: string;
    maxBytes?: number;
  }): { lines: LogLine[]; reason: "app-windowed" | "buffer-rolled-past" | "no-app-lines" } {
    const selected: LogLine[] = [];
    let reachedBack = false;
    for (let i = this.lines.length - 1; i >= this.head && selected.length < count; i -= 1) {
      const line = this.lines[i]!;
      if (line.at > at) continue;
      reachedBack = true;
      if (emittedBy(line.raw, processName)) selected.push(line);
    }
    if (!reachedBack) return { lines: [], reason: "buffer-rolled-past" };
    if (selected.length === 0) return { lines: [], reason: "no-app-lines" };

    selected.reverse();
    if (maxBytes === undefined) return { lines: selected, reason: "app-windowed" };
    let bytes = 0;
    let first = selected.length;
    while (first > 0 && bytes + selected[first - 1]!.raw.length <= maxBytes) {
      bytes += selected[first - 1]!.raw.length;
      first -= 1;
    }
    return { lines: selected.slice(Math.min(first, selected.length - 1)), reason: "app-windowed" };
  }

  get latestSeq(): number {
    return this.seq;
  }

  /** Lets a `since` reader detect that eviction dropped the range it asked for. */
  get oldestSeq(): number {
    return this.lines[this.head]?.seq ?? this.seq;
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.deps.idleAfterMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.restartTimer) {
        this.armIdle();
        return;
      }
      this.releaseIfIdle();
    }, this.deps.idleAfterMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private spawn(): void {
    let child: ChildProcess;
    try {
      child = this.deps.spawnLogStream(this.udid);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.child = null;
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.decoder = new StringDecoder("utf8");
    this.partial = "";
    this.dropping = false;
    const gone = (reason: string): void => {
      if (this.child !== child) return;
      this.lastError = reason;
      this.onChildGone();
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.consume(this.decoder.write(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.lastError = chunk.toString().trim().slice(0, 500) || this.lastError;
    });
    child.on("error", (error: Error) => gone(error.message));
    child.on("exit", (code, signal) => gone(`log stream exited (code ${code}, signal ${signal})`));
    if (this.listenerCount === 0) this.armIdle();
  }

  private onChildGone(): void {
    this.child = null;
    this.consecutiveFailures += 1;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const delay = Math.min(
      MAX_RESTART_DELAY_MS,
      this.deps.restartDelayMs * 2 ** Math.max(0, this.consecutiveFailures - 1)
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped && !this.child) this.spawn();
    }, delay);
    this.restartTimer.unref?.();
  }

  private consume(text: string): void {
    this.partial += text;
    const batch: LogLine[] = [];
    let nl: number;
    while ((nl = this.partial.indexOf("\n")) !== -1) {
      const raw = this.partial.slice(0, nl).trim();
      this.partial = this.partial.slice(nl + 1);
      if (this.dropping) {
        this.dropping = false;
        continue;
      }
      if (raw) batch.push(this.append(raw));
    }
    if (this.partial.length > LINE_BUFFER_LIMIT) {
      this.partial = "";
      this.dropping = true;
    }
    if (batch.length === 0) return;
    for (const listener of this.listeners) {
      for (const line of batch) {
        try {
          listener(line);
        } catch {
          // A closed SSE socket must not stop the ring or the other listeners.
        }
      }
    }
    for (const listener of this.batchListeners) {
      try {
        listener(batch);
      } catch {
        // A closed SSE socket must not stop the ring or the other listeners.
      }
    }
  }

  private append(raw: string): LogLine {
    const line: LogLine = { seq: ++this.seq, at: this.deps.now(), raw };
    this.lines.push(line);
    this.bytes += raw.length;
    this.evictOverflow();
    return line;
  }

  private evictOverflow(): void {
    while (this.bytes > this.deps.maxBytes && this.lines.length - this.head > 1) {
      this.bytes -= this.lines[this.head]!.raw.length;
      this.head += 1;
    }
    if (this.head > 0 && (this.head > 2048 || this.head * 2 >= this.lines.length)) {
      this.lines = this.lines.slice(this.head);
      this.head = 0;
    }
  }
}

export type LogBufferCache = ReturnType<typeof createLogBufferCache>;

export function createLogBufferCache(deps: LogBufferDeps = {}) {
  const resolved: Required<LogBufferDeps> = {
    spawnLogStream: deps.spawnLogStream ?? spawnDeviceLogStream,
    maxBytes: deps.maxBytes ?? DEFAULT_MAX_BYTES,
    restartDelayMs: deps.restartDelayMs ?? RESTART_DELAY_MS,
    idleAfterMs: deps.idleAfterMs ?? POLL_IDLE_MS,
    now: deps.now ?? (() => Date.now()),
  };
  const byUdid = new Map<string, DeviceLogBuffer>();

  return {
    ensure(udid: string): DeviceLogBuffer {
      const existing = byUdid.get(udid);
      if (existing) {
        existing.start();
        return existing;
      }
      const buffer = new DeviceLogBuffer(udid, resolved);
      byUdid.set(udid, buffer);
      buffer.start();
      return buffer;
    },

    peek(udid: string): DeviceLogBuffer | null {
      return byUdid.get(udid) ?? null;
    },

    prune(liveUdids: readonly string[]): void {
      // An empty list usually means the state read failed, not that every device went away.
      if (liveUdids.length === 0) return;
      const live = new Set(liveUdids);
      for (const [udid, buffer] of byUdid) {
        // Identity-guard so a stale prune cannot stop a replacement buffer.
        if (live.has(udid) || byUdid.get(udid) !== buffer) continue;
        buffer.stop();
        byUdid.delete(udid);
      }
    },

    stopAll(): void {
      for (const buffer of byUdid.values()) buffer.stop();
      byUdid.clear();
    },
  };
}

export const logBufferCache = createLogBufferCache();
