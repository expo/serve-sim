import { createHash, randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { MAX_HAR_ENTRIES, toHarEntry } from "./har";
import { compactNdjsonAndStreamHar, emptyHarText } from "./har-stream";
import type { CapturedBody, CapturedRequest, CaptureEvent, CaptureStore } from "./store";
import { withLaunchStateLockSync } from "../launch-state-lock";
import { stateDir } from "../state";

export const NETWORK_CAPTURE_FILENAME = "network-capture.json";
export const CAPTURE_HAR_FILENAME = "capture.har";
/** One HarEntry JSON object per line; source of truth for streaming capture.har rebuilds. */
export const CAPTURE_ENTRIES_FILENAME = "capture.entries.ndjson";

export function captureDirForDevice(udid: string): string {
  return join(stateDir(), `capture-${udid}`);
}

const CAPTURE_DIR_PREFIX = "capture-";

function withArtifactLock<T>(dir: string, operation: () => T): T {
  const key = createHash("sha256").update(resolve(dir)).digest("hex");
  return withLaunchStateLockSync(`capture-artifacts-${key}`, operation);
}

export const CAPTURE_OWNER_FILENAME = "owner.pid";

/**
 * Whether a capture directory belongs to a process that is still running.
 *
 * The owner file is written when the directory is created and goes with it, so a directory only looks
 * owned while its writer is alive. A device's state file cannot answer this: it is written later, after
 * the preview port binds, and it outlives a killed process.
 */
function ownerIsRunning(dir: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(join(dir, CAPTURE_OWNER_FILENAME), "utf-8").trim().split("\n")[0]);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

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
  deps: {
    list?: () => string[];
    remove?: (dir: string) => void;
    ownedByLiveProcess?: (dir: string) => boolean;
  } = {},
): number {
  const owned = deps.ownedByLiveProcess ?? ownerIsRunning;
  const keep = new Set(keepUdids.map((udid) => `${CAPTURE_DIR_PREFIX}${udid}`));
  const list =
    deps.list ??
    (() => {
      try {
        return readdirSync(stateDir());
      } catch {
        return [];
      }
    });
  const remove = deps.remove ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }));

  let swept = 0;
  for (const name of list()) {
    if (!name.startsWith(CAPTURE_DIR_PREFIX) || keep.has(name)) continue;
    try {
      withArtifactLock(join(stateDir(), name), () => {
        if (owned(join(stateDir(), name))) return;
        remove(join(stateDir(), name));
        swept++;
      });
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
  private owner: string | null = null;
  private ending: Promise<Error | null> | null = null;

  constructor(opts: CaptureDiskAccumulatorOptions) {
    this.dir = opts.dir;
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
    if (this.started) return;
    withArtifactLock(this.dir, () => {
      if (ownerIsRunning(this.dir)) {
        throw new Error(`Network capture already owns ${this.dir}. Stop that recording before starting another for this device or output directory.`);
      }
      mkdirSync(this.dir, { recursive: true });
      const owner = `${process.pid}\n${randomUUID()}`;
      writeFileSync(join(this.dir, CAPTURE_OWNER_FILENAME), owner);
      try {
        writeFileSync(this.networkCapturePath, "");
        writeFileSync(this.entriesPath, "");
        writeFileSync(this.harPath, emptyHarText(this.creatorVersion));
        this.owner = owner;
      } catch (error) {
        unlinkSync(join(this.dir, CAPTURE_OWNER_FILENAME));
        throw error;
      }
    });
    this.ending = null;
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
    return async () => {
      await this.end({ removeDir: true });
    };
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
   *
   * Returns the failure when the last write did not land, so a caller that reports a result can say the
   * file it names is incomplete. Teardown on shutdown ignores it, which is why this never throws.
   */
  end(opts: { removeDir?: boolean } = {}): Promise<Error | null> {
    if (!this.ending) this.ending = this.finish(opts);
    return this.ending;
  }

  private async finish(opts: { removeDir?: boolean }): Promise<Error | null> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    let failure: Error | null = null;
    try {
      await this.flush();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      console.warn(`Network capture: flush before end (${this.dir}) failed:`, failure.message);
    }
    try {
      withArtifactLock(this.dir, () => {
        if (!this.owner) return;
        let owner: string;
        try { owner = readFileSync(join(this.dir, CAPTURE_OWNER_FILENAME), "utf8"); } catch { return; }
        if (owner !== this.owner) return;
        if (opts.removeDir) rmSync(this.dir, { recursive: true, force: true });
        else unlinkSync(join(this.dir, CAPTURE_OWNER_FILENAME));
      });
    } catch (error) {
      console.warn(`Network capture: releasing ${this.dir} failed:`, error);
    }
    this.owner = null;
    return failure;
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
      // Cleared before the compact reads: a request that finishes during it stays dirty.
      this.harDirty = false;
      await this.flushPendingEntries();
      this.diskEntryCount = await compactNdjsonAndStreamHar(
        this.entriesPath,
        this.harPath,
        this.creatorVersion,
        this.maxEntries,
      );
      this.lastWriteError = null;
    });
    await this.writeChain;
  }
}
