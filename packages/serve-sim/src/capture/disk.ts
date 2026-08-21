import { appendFile } from "node:fs/promises";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { MAX_HAR_ENTRIES, toHarEntry } from "./har";
import { compactNdjsonAndStreamHar, emptyHarText } from "./har-stream";
import type { CapturedBody, CapturedRequest, CaptureEvent, CaptureStore } from "./store";
import { STATE_DIR } from "../state";

export const NETWORK_CAPTURE_FILENAME = "network-capture.json";
export const CAPTURE_HAR_FILENAME = "capture.har";
/** One HarEntry JSON object per line; source of truth for streaming capture.har rebuilds. */
export const CAPTURE_ENTRIES_FILENAME = "capture.entries.ndjson";

export function captureDirForDevice(udid: string): string {
  return join(STATE_DIR, `capture-${udid}`);
}

const CAPTURE_DIR_PREFIX = "capture-";

/**
 * Remove capture directories no live session owns.
 *
 * A session removes its own directory when it ends, but a crash or a kill leaves whatever it had already
 * written — request bodies included, when they were asked for — sitting in the state directory with
 * nothing scheduled to collect it. Reclaiming those at the next start is what bounds how long captured
 * traffic can survive on disk.
 */
export function sweepAbandonedCaptureDirs(
  keepUdids: readonly string[],
  deps: { list?: () => string[]; remove?: (dir: string) => void } = {},
): number {
  const keep = new Set(keepUdids.map((udid) => `${CAPTURE_DIR_PREFIX}${udid}`));
  const list =
    deps.list ??
    (() => {
      try {
        return readdirSync(STATE_DIR);
      } catch {
        return [];
      }
    });
  const remove = deps.remove ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }));

  let swept = 0;
  for (const name of list()) {
    if (!name.startsWith(CAPTURE_DIR_PREFIX) || keep.has(name)) continue;
    try {
      remove(join(STATE_DIR, name));
      swept++;
    } catch {
      // Another process may be sweeping the same directory.
    }
  }
  return swept;
}

export function captureArtifactPaths(udid: string): {
  dir: string;
  networkCapturePath: string;
  harPath: string;
  entriesPath: string;
} {
  const dir = captureDirForDevice(udid);
  return {
    dir,
    networkCapturePath: join(dir, NETWORK_CAPTURE_FILENAME),
    harPath: join(dir, CAPTURE_HAR_FILENAME),
    entriesPath: join(dir, CAPTURE_ENTRIES_FILENAME),
  };
}

export interface CaptureDiskAccumulatorOptions {
  dir: string;
  networkCapturePath?: string;
  harPath?: string;
  creatorVersion?: string;
  flushIntervalMs?: number;
  maxEntries?: number;
}

/**
 * Single writer for capture artifacts: events NDJSON, finished-entry NDJSON, streamed capture.har.
 * Live session attaches a store; CLI follow calls begin / record* / end.
 */
export class CaptureDiskAccumulator {
  readonly dir: string;
  readonly networkCapturePath: string;
  readonly harPath: string;
  readonly entriesPath: string;
  private readonly creatorVersion: string;
  private readonly maxEntries: number;
  private readonly flushMs: number;
  /** Lines known to be on disk in entriesPath (pending not included). */
  private diskEntryCount = 0;
  private harDirty = false;
  private lastWriteError: unknown = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private pendingEventLines: string[] = [];
  private pendingEntryLines: string[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private started = false;

  constructor(opts: CaptureDiskAccumulatorOptions) {
    this.dir = opts.dir;
    mkdirSync(opts.dir, { recursive: true });
    this.networkCapturePath =
      opts.networkCapturePath ?? join(opts.dir, NETWORK_CAPTURE_FILENAME);
    this.harPath = opts.harPath ?? join(opts.dir, CAPTURE_HAR_FILENAME);
    this.entriesPath = join(opts.dir, CAPTURE_ENTRIES_FILENAME);
    this.creatorVersion = opts.creatorVersion ?? "0.0.0";
    this.maxEntries = opts.maxEntries ?? MAX_HAR_ENTRIES;
    this.flushMs = opts.flushIntervalMs ?? 5_000;
  }

  get size(): number {
    return this.diskEntryCount + this.pendingEntryLines.length;
  }

  /** Open empty artifact files and start the HAR rebuild interval. */
  begin(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.pendingEventLines = [];
    this.pendingEntryLines = [];
    this.writeChain = Promise.resolve();
    this.diskEntryCount = 0;
    this.harDirty = false;
    this.lastWriteError = null;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.networkCapturePath, "");
    writeFileSync(this.entriesPath, "");
    writeFileSync(this.harPath, emptyHarText(this.creatorVersion));

    this.timer = setInterval(() => {
      void this.rebuildHarIfDirty();
    }, this.flushMs);
    this.timer.unref?.();
    this.started = true;
  }

  /** Subscribe to a live store; removes the session dir on end. */
  attach(store: CaptureStore): () => Promise<void> {
    this.begin();
    this.unsubscribe = store.subscribe((event) => this.onStoreEvent(store, event));
    this.recordEvent({ type: "session", startedAt: new Date().toISOString() });
    return () => this.end({ removeDir: true });
  }

  /** Append one event line to network-capture.json (any SSE payload). */
  recordEvent(event: unknown): void {
    if (!this.started) this.begin();
    this.pendingEventLines.push(typeof event === "string" ? event : JSON.stringify(event));
    this.enqueue(() => this.flushPendingEvents());
  }

  /** Append one finished HarEntry line; bodies must already be available. */
  recordFinished(request: CapturedRequest, body: CapturedBody | null = null): void {
    if (!this.started) this.begin();
    this.pendingEntryLines.push(JSON.stringify(toHarEntry(request, body)));
    this.harDirty = true;
    this.enqueue(() => this.flushPendingEntries());
  }

  /** Drain NDJSON queues and stream-rebuild capture.har. Throws the last write error if any. */
  async flush(): Promise<void> {
    await this.drainPending();
    await this.rebuildHarIfDirty();
    await this.writeChain;
    if (this.lastWriteError) {
      const err = this.lastWriteError;
      this.lastWriteError = null;
      throw err;
    }
  }

  /**
   * Stop the interval and flush. Session capture passes `removeDir: true`;
   * CLI follow keeps the files (`removeDir: false`).
   */
  async end(opts: { removeDir?: boolean } = {}): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    try {
      await this.flush();
    } catch (error) {
      console.warn(
        `Network capture: flush before end (${this.dir}) failed:`,
        error instanceof Error ? error.message : error,
      );
    }
    if (!opts.removeDir) return;
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch (error) {
      console.warn(
        `Network capture: removing ${this.dir} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /** @deprecated Prefer end({ removeDir: true }). */
  async stop(): Promise<void> {
    await this.end({ removeDir: true });
  }

  private enqueue(task: () => Promise<void>): void {
    this.writeChain = this.writeChain.then(task).catch((err) => {
      this.harDirty = true;
      this.lastWriteError = err;
    });
  }

  private onStoreEvent(store: CaptureStore, event: CaptureEvent): void {
    this.recordEvent(event);

    // Live store clear empties the UI window; session HAR keeps entries until end().
    if (event.type === "cleared") return;
    if (event.type === "meta") return;
    // Finished-only: bodies land on finish; skip in-flight started rows.
    if (event.type !== "finished") return;

    this.recordFinished(event.request, store.body(event.request.id));
  }

  private async flushPendingEvents(): Promise<void> {
    if (this.pendingEventLines.length === 0) return;
    const batch = this.pendingEventLines.splice(0, this.pendingEventLines.length);
    try {
      await appendFile(this.networkCapturePath, `${batch.join("\n")}\n`);
    } catch (err) {
      this.pendingEventLines.unshift(...batch);
      throw err;
    }
  }

  private async flushPendingEntries(): Promise<void> {
    if (this.pendingEntryLines.length === 0) return;
    const batch = this.pendingEntryLines.splice(0, this.pendingEntryLines.length);
    try {
      await appendFile(this.entriesPath, `${batch.join("\n")}\n`);
      this.diskEntryCount += batch.length;
    } catch (err) {
      this.pendingEntryLines.unshift(...batch);
      throw err;
    }
  }

  private async drainPending(): Promise<void> {
    await this.writeChain;
    if (this.pendingEventLines.length > 0) {
      const batch = this.pendingEventLines.splice(0, this.pendingEventLines.length);
      try {
        appendFileSync(this.networkCapturePath, `${batch.join("\n")}\n`);
      } catch (err) {
        this.pendingEventLines.unshift(...batch);
        throw err;
      }
    }
    if (this.pendingEntryLines.length > 0) {
      const batch = this.pendingEntryLines.splice(0, this.pendingEntryLines.length);
      try {
        appendFileSync(this.entriesPath, `${batch.join("\n")}\n`);
        this.diskEntryCount += batch.length;
        this.harDirty = true;
      } catch (err) {
        this.pendingEntryLines.unshift(...batch);
        throw err;
      }
    }
  }

  private async rebuildHarIfDirty(): Promise<void> {
    if (!this.harDirty) return;
    this.enqueue(async () => {
      await this.flushPendingEntries();
      this.diskEntryCount = await compactNdjsonAndStreamHar(
        this.entriesPath,
        this.harPath,
        this.creatorVersion,
        this.maxEntries,
      );
      this.harDirty = false;
      this.lastWriteError = null;
    });
    await this.writeChain;
  }
}
