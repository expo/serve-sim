// CPU/mem of the user's app on a booted sim, measured host-side (%CPU is per-core, can exceed 100).
// Scopes to the foreground app (the one the tools panel shows) via axFrontmost. Memory is
// phys_footprint (the number Xcode's gauge shows), with an RSS fallback.

import { execFile } from "node:child_process";
import { cpus } from "node:os";
import { promisify } from "node:util";

import { axFrontmostAsync } from "./native";

const execFileAsync = promisify(execFile);

export const METRICS_SCHEMA_VERSION = 1;

export interface AppUsage {
  cpuPct: number;
  memBytes: number;
}

export interface MetricSample extends AppUsage {
  t: number; // ms since the sampler started
}

export interface MetricsMeta {
  schemaVersion: number;
  udid: string;
  hostCores: number;
  sampleIntervalMs: number;
}

export interface AppProcesses {
  pids: number[];
  cpuPct: number;
  rssKb: number;
}

interface PsRow {
  pid: number;
  pcpu: number;
  rssKb: number;
  appPath: string; // the `.app` bundle this process runs from (host app + its extensions share it)
}

// Processes running from the sim's Containers/Bundle path (the user apps), not the ~190 system daemons.
function parseUserAppRows(output: string, udid: string): PsRow[] {
  const device = `/Devices/${udid}/`.toUpperCase();
  const rows: PsRow[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const args = m[4]!;
    const upper = args.toUpperCase();
    if (!upper.includes(device) || !upper.includes("/CONTAINERS/BUNDLE/APPLICATION/")) continue;
    // First `.app` in the exec path; extensions live under it (…/MyApp.app/PlugIns/X.appex/X).
    const app = /^(.*?\.app)\//.exec(args);
    rows.push({ pid: +m[1]!, pcpu: +m[2]!, rssKb: +m[3]!, appPath: app ? app[1]! : args });
  }
  return rows;
}

// Aggregate the user app's processes. With a frontmost pid, narrow to just that app's `.app`
// bundle (its host process + extensions); without one, sum every user app on the sim.
export function findUserAppProcesses(
  output: string,
  udid: string,
  frontmostPid?: number,
): AppProcesses | null {
  const rows = parseUserAppRows(output, udid);
  if (!rows.length) return null;

  const front = frontmostPid != null ? rows.find((r) => r.pid === frontmostPid) : undefined;
  const scoped = front ? rows.filter((r) => r.appPath === front.appPath) : rows;

  return {
    pids: scoped.map((r) => r.pid),
    cpuPct: +scoped.reduce((sum, r) => sum + r.pcpu, 0).toFixed(1),
    rssKb: scoped.reduce((sum, r) => sum + r.rssKb, 0),
  };
}

// Sum the per-process `phys_footprint: <n> B` lines (skips _peak and the Summary line).
export function sumPhysFootprintBytes(output: string): number | null {
  let bytes = 0;
  let found = false;
  for (const m of output.matchAll(/^\s*phys_footprint:\s+(\d+) B$/gm)) {
    bytes += +m[1]!;
    found = true;
  }
  return found ? bytes : null;
}

// Injected so tests can drive sampleUserApp without spawning real processes.
export interface SampleDeps {
  exec?: (file: string, args: string[]) => Promise<string>;
  frontmostPid?: (udid: string) => Promise<number | undefined>;
}

const runCommand = (file: string, args: string[]): Promise<string> =>
  execFileAsync(file, args, { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout);

async function frontmostPidOf(udid: string): Promise<number | undefined> {
  try {
    return (JSON.parse(await axFrontmostAsync(udid)) as { pid?: number }).pid;
  } catch {
    // AX bridge warming up or unreachable: caller falls back to summing every user app.
    return undefined;
  }
}

// CPU side: the foreground app's processes and their %CPU. `ps` and the frontmost
// probe don't depend on each other, so they run together.
async function sampleCpu(udid: string, deps: Required<SampleDeps>): Promise<AppProcesses | null> {
  const [psOutput, frontmostPid] = await Promise.all([
    deps.exec("ps", ["-axo", "pid=,pcpu=,rss=,args="]).catch(() => null),
    deps.frontmostPid(udid),
  ]);
  return psOutput == null ? null : findUserAppProcesses(psOutput, udid, frontmostPid);
}

// Memory side: phys_footprint of the app's processes. Depends on the pids the CPU
// side found, so it can't start until those are known; RSS is the fallback.
async function sampleMemoryBytes(procs: AppProcesses, deps: Required<SampleDeps>): Promise<number> {
  try {
    const output = await deps.exec("footprint", ["--noCategories", "--format", "bytes", ...procs.pids.map(String)]);
    return sumPhysFootprintBytes(output) ?? procs.rssKb * 1024;
  } catch {
    // footprint can exit non-zero (all pids gone mid-tick); keep the RSS fallback.
    return procs.rssKb * 1024;
  }
}

export async function sampleUserApp(udid: string, deps: SampleDeps = {}): Promise<AppUsage | null> {
  const resolved: Required<SampleDeps> = {
    exec: deps.exec ?? runCommand,
    frontmostPid: deps.frontmostPid ?? frontmostPidOf,
  };
  const procs = await sampleCpu(udid, resolved);
  if (!procs) return null;
  return { cpuPct: procs.cpuPct, memBytes: await sampleMemoryBytes(procs, resolved) };
}

export interface MetricsSamplerOptions {
  udid: string;
  intervalMs?: number;
  sample?: (udid: string) => Promise<AppUsage | null>;
  now?: () => number;
  hostCores?: number;
}

// Polls the sim and fans samples out; reschedules only after each tick settles, so ticks never overlap.
export class MetricsSampler {
  readonly meta: MetricsMeta;

  private readonly intervalMs: number;
  private readonly sample: (udid: string) => Promise<AppUsage | null>;
  private readonly now: () => number;
  private readonly listeners = new Set<(sample: MetricSample) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private startedAt: number | null = null;

  constructor(opts: MetricsSamplerOptions) {
    this.intervalMs = opts.intervalMs ?? 1000;
    this.sample = opts.sample ?? sampleUserApp;
    this.now = opts.now ?? Date.now;
    this.meta = {
      schemaVersion: METRICS_SCHEMA_VERSION,
      udid: opts.udid,
      hostCores: opts.hostCores ?? cpus().length,
      sampleIntervalMs: this.intervalMs,
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  onSample(listener: (sample: MetricSample) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async tickOnce(): Promise<MetricSample | null> {
    this.startedAt ??= this.now();
    const reading = await this.sample(this.meta.udid);
    if (!reading) return null;

    const sample: MetricSample = { t: this.now() - this.startedAt, ...reading };
    for (const listener of this.listeners) listener(sample);
    return sample;
  }

  start(): void {
    if (this.timer) return;
    this.startedAt ??= this.now();
    const loop = async (): Promise<void> => {
      await this.tickOnce().catch(() => {});
      if (this.timer) this.timer = setTimeout(loop, this.intervalMs);
    };
    this.timer = setTimeout(loop, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export interface MetricsSubscription {
  meta: MetricsMeta;
  unsubscribe: () => void;
}

// One shared sampler per udid (like the ax streamer cache); ref-counted by subscribers.
export function createMetricsSamplerCache(
  makeSampler: (udid: string) => MetricsSampler = (udid) => new MetricsSampler({ udid }),
) {
  const byUdid = new Map<string, MetricsSampler>();
  return {
    subscribe(udid: string, listener: (sample: MetricSample) => void): MetricsSubscription {
      let sampler = byUdid.get(udid);
      if (!sampler) {
        sampler = makeSampler(udid);
        byUdid.set(udid, sampler);
        sampler.start();
      }
      const off = sampler.onSample(listener);
      return {
        meta: sampler.meta,
        unsubscribe: () => {
          off();
          if (sampler.listenerCount === 0) {
            sampler.stop();
            byUdid.delete(udid);
          }
        },
      };
    },
  };
}
