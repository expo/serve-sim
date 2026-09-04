import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

import { axFrontmostAsync } from "./native";

const execFileAsync = promisify(execFile);

export interface ForegroundApp {
  pid: number;
  bundleId: string;
}

const NON_UI_BUNDLE_RE =
  /(^|\.)(WidgetRenderer|ExtensionHost|Service|PlaceholderApp|InCallService|CallUI|InCallUI)(\.|$)|\.extension(\.|$)|com\.apple\.(Preferences\.Cellular|purplebuddy|chrono|shuttle|usernotificationsui)/i;

export function isUserFacingBundle(bundleId: string): boolean {
  return !NON_UI_BUNDLE_RE.test(bundleId);
}

export function parseAppVisibilityLogMessage(
  message: string,
): (ForegroundApp & { foreground: boolean }) | null {
  const match =
    /\[app<([^>]+)>:(\d+)\] Setting process visibility to: (Foreground|Background)/.exec(message);
  if (!match) return null;
  return {
    bundleId: match[1]!,
    pid: parseInt(match[2]!, 10),
    foreground: match[3] === "Foreground",
  };
}

export function frontmostAppFromLogOutput(output: string): ForegroundApp | null {
  const backgrounded = new Set<string>();
  for (const line of output.split("\n").reverse()) {
    try {
      const message = JSON.parse(line).eventMessage ?? "";
      const app = parseAppVisibilityLogMessage(message);
      if (!app || !isUserFacingBundle(app.bundleId) || backgrounded.has(app.bundleId)) continue;
      if (app.foreground) return { bundleId: app.bundleId, pid: app.pid };
      backgrounded.add(app.bundleId);
    } catch {}
  }
  return null;
}

const LINE_BUFFER_LIMIT = 1024 * 1024;
const RESTART_DELAY_MS = 1000;

function spawnForegroundLogStream(udid: string): ChildProcess {
  return spawn(
    "xcrun",
    [
      "simctl", "spawn", udid, "log", "stream",
      "--style", "ndjson",
      "--level", "info",
      "--predicate",
      'process == "SpringBoard" AND eventMessage CONTAINS "Setting process visibility to: Foreground"',
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
}

export async function frontmostAppViaAx(udid: string): Promise<ForegroundApp | null> {
  try {
    const { pid, bundleId } = JSON.parse(await axFrontmostAsync(udid)) as {
      pid?: number;
      bundleId?: string;
    };
    return pid != null && bundleId ? { pid, bundleId } : null;
  } catch {
    return null;
  }
}

export async function frontmostAppViaRecentLogs(
  udid: string,
  deps: {
    readLogs?: (udid: string) => Promise<string>;
    isProcessAlive?: (pid: number) => boolean;
  } = {},
): Promise<ForegroundApp | null> {
  try {
    const stdout = deps.readLogs
      ? await deps.readLogs(udid)
      : (
          await execFileAsync(
            "xcrun",
            [
              "simctl", "spawn", udid, "log", "show",
              "--style", "ndjson",
              "--last", "15m",
              "--predicate",
              'process == "SpringBoard" AND eventMessage CONTAINS "Setting process visibility to:"',
            ],
            { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
          )
        ).stdout;
    const app = frontmostAppFromLogOutput(stdout);
    if (!app) return null;
    if (deps.isProcessAlive) return deps.isProcessAlive(app.pid) ? app : null;
    try {
      process.kill(app.pid, 0);
      return app;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM" ? app : null;
    }
  } catch {
    return null;
  }
}

async function seedFrontmostApp(udid: string): Promise<ForegroundApp | null> {
  return (await frontmostAppViaAx(udid)) ?? frontmostAppViaRecentLogs(udid);
}

export interface ForegroundTrackerDeps {
  spawnLogStream?: (udid: string) => ChildProcess;
  frontmostApp?: (udid: string) => Promise<ForegroundApp | null>;
  restartDelayMs?: number;
}

class ForegroundTracker {
  private child: ChildProcess | null = null;
  private buf = "";
  private latest: ForegroundApp | null = null;
  private stopped = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(app: ForegroundApp) => void>();

  constructor(
    private readonly udid: string,
    private readonly deps: Required<ForegroundTrackerDeps>,
  ) {}

  get current(): ForegroundApp | null {
    return this.latest;
  }

  add(listener: (app: ForegroundApp) => void): void {
    this.listeners.add(listener);
  }

  remove(listener: (app: ForegroundApp) => void): number {
    this.listeners.delete(listener);
    return this.listeners.size;
  }

  start(): void {
    this.deps
      .frontmostApp(this.udid)
      .then((app) => {
        if (app && this.latest === null) this.set(app);
      })
      .catch(() => {});
    this.spawn();
  }

  private spawn(): void {
    const child = this.deps.spawnLogStream(this.udid);
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk.toString()));
    child.on("error", () => this.onChildGone());
    child.on("exit", () => this.onChildGone());
  }

  private onChildGone(): void {
    if (this.stopped || this.restartTimer) return;
    this.child = null;
    if (this.listeners.size === 0) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped && !this.child && this.listeners.size > 0) this.spawn();
    }, this.deps.restartDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.child?.stdout?.destroy();
    this.child?.kill();
    this.child = null;
    this.buf = "";
  }

  private consume(text: string): void {
    this.buf += text;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let message: string;
      try {
        message = JSON.parse(line).eventMessage ?? "";
      } catch {
        continue;
      }
      const app = parseAppVisibilityLogMessage(message);
      if (app?.foreground) this.set({ bundleId: app.bundleId, pid: app.pid });
    }
    if (this.buf.length > LINE_BUFFER_LIMIT) this.buf = "";
  }

  private set(app: ForegroundApp): void {
    if (!isUserFacingBundle(app.bundleId)) return;
    if (app.bundleId === this.latest?.bundleId && app.pid === this.latest.pid) return;
    this.latest = app;
    for (const listener of this.listeners) {
      try {
        listener(app);
      } catch {}
    }
  }
}

export type ForegroundTrackerCache = ReturnType<typeof createForegroundTrackerCache>;

export function createForegroundTrackerCache(deps: ForegroundTrackerDeps = {}) {
  const resolved: Required<ForegroundTrackerDeps> = {
    spawnLogStream: deps.spawnLogStream ?? spawnForegroundLogStream,
    frontmostApp: deps.frontmostApp ?? seedFrontmostApp,
    restartDelayMs: deps.restartDelayMs ?? RESTART_DELAY_MS,
  };
  const byUdid = new Map<string, ForegroundTracker>();
  return {
    peek(udid: string): ForegroundApp | null {
      return byUdid.get(udid)?.current ?? null;
    },
    subscribe(udid: string, onChange?: (app: ForegroundApp) => void): { unsubscribe: () => void } {
      let tracker = byUdid.get(udid);
      if (!tracker) {
        tracker = new ForegroundTracker(udid, resolved);
        byUdid.set(udid, tracker);
        tracker.start();
      }
      const listener = (app: ForegroundApp) => onChange?.(app);
      tracker.add(listener);
      return {
        unsubscribe: () => {
          if (tracker.remove(listener) === 0 && byUdid.get(udid) === tracker) {
            tracker.stop();
            byUdid.delete(udid);
          }
        },
      };
    },
  };
}

export const foregroundTracker = createForegroundTrackerCache();
