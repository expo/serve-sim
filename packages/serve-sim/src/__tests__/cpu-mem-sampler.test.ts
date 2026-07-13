import { describe, expect, it } from "bun:test";

import {
  createMetricsSamplerCache,
  findUserAppProcesses,
  MetricsSampler,
  sampleUserApp,
  sumPhysFootprintBytes,
  type MetricSample,
} from "../cpu-mem-sampler";

const UDID = "ABCD1234-0000-0000-0000-0000000000EF";

// `ps -axo pid= pcpu= rss= args=` — the user app and its extension run from the sim's
// Containers/Bundle/Application path; launchd_sim and a RuntimeRoot daemon do not,
// and an unrelated host process is off-device. Only the first two count.
function psFixture(): string {
  return [
    `  101   0.1  15000 launchd_sim /x/Devices/${UDID}/data/var/run/launchd_bootstrap.plist`,
    `  102  40.0  32000 /Runtime/RuntimeRoot/System/Library/PrivateFrameworks/ApplePushService.framework/apsd`,
    `  103   4.0  80000 /x/Devices/${UDID}/data/Containers/Bundle/Application/AAA/MyApp.app/MyApp`,
    `  104   1.0  20000 /x/Devices/${UDID}/data/Containers/Bundle/Application/AAA/MyApp.app/PlugIns/Share.appex/Share`,
    `  105   9.9 999999 /some/host/process --unrelated`,
  ].join("\n");
}

// A second user app ("Two Words.app", a space in its path like real "Expo Go.app") on the same sim.
function psFixtureTwoApps(): string {
  return [
    psFixture(),
    `  106   2.0  50000 /x/Devices/${UDID}/data/Containers/Bundle/Application/BBB/Two Words.app/Two Words`,
  ].join("\n");
}

describe("findUserAppProcesses", () => {
  it("collects pids + cpu% + rss over the sim's user-installed app (app + extensions)", () => {
    // app 4.0 + extension 1.0 = 5.0 ; (80000 + 20000) KB — system/host procs excluded
    expect(findUserAppProcesses(psFixture(), UDID)).toEqual({
      pids: [103, 104],
      cpuPct: 5,
      rssKb: 80000 + 20000,
    });
  });

  it("matches the device path case-insensitively", () => {
    const ps = `7 2.0 1000 /x/Devices/${UDID.toLowerCase()}/data/Containers/Bundle/Application/AAA/App.app/App`;
    expect(findUserAppProcesses(ps, UDID)).toEqual({ pids: [7], cpuPct: 2, rssKb: 1000 });
  });

  it("narrows to the frontmost app's bundle (host + extensions), ignoring other user apps", () => {
    // frontmost pid 103 -> MyApp.app; sums MyApp + its Share extension, not the other app
    expect(findUserAppProcesses(psFixtureTwoApps(), UDID, 103)).toEqual({
      pids: [103, 104],
      cpuPct: 5,
      rssKb: 80000 + 20000,
    });
    // frontmost is the space-named app -> just that bundle
    expect(findUserAppProcesses(psFixtureTwoApps(), UDID, 106)).toEqual({
      pids: [106],
      cpuPct: 2,
      rssKb: 50000,
    });
  });

  it("sums every user app when the frontmost pid isn't one of them (e.g. SpringBoard)", () => {
    expect(findUserAppProcesses(psFixtureTwoApps(), UDID, 999999)).toEqual({
      pids: [103, 104, 106],
      cpuPct: 7,
      rssKb: 80000 + 20000 + 50000,
    });
  });

  it("returns null when no user app is running on this sim", () => {
    // right sim, but only a system process (no Containers/Bundle path)
    expect(
      findUserAppProcesses(`1 0.1 15000 launchd_sim /x/Devices/${UDID}/data/var/run/x.plist\n`, UDID),
    ).toBeNull();
    expect(findUserAppProcesses("", UDID)).toBeNull();
  });
});

describe("sumPhysFootprintBytes", () => {
  // `footprint --noCategories --format bytes <pid> <pid>` output shape
  const footprintFixture = [
    "======================================================================",
    "MyApp [103]: 64-bit    Footprint: 253904480 B (16384 bytes per page)",
    "======================================================================",
    "",
    "Auxiliary data:",
    "    phys_footprint: 253937248 B",
    "    phys_footprint_peak: 333989448 B",
    "",
    "======================================================================",
    "Share [104]: 64-bit    Footprint: 2244968 B (16384 bytes per page)",
    "======================================================================",
    "",
    "Auxiliary data:",
    "    phys_footprint: 2261352 B",
    "    phys_footprint_peak: 2310504 B",
    "",
    "======================================================================",
    "Summary Footprint: 256100296 B",
    "======================================================================",
  ].join("\n");

  it("sums per-process phys_footprint, ignoring peaks and the summary", () => {
    expect(sumPhysFootprintBytes(footprintFixture)).toBe(253937248 + 2261352);
  });

  it("returns null when no process was reported", () => {
    expect(sumPhysFootprintBytes("")).toBeNull();
    expect(sumPhysFootprintBytes("footprint: Unable to find pid for process matching '9'")).toBeNull();
  });
});

describe("sampleUserApp", () => {
  const footprintFor = (pids: string[]): string =>
    pids.map((pid) => `App [${pid}]:\nAuxiliary data:\n    phys_footprint: 1000000 B\n`).join("\n");

  it("scopes to the frontmost app and combines ps (cpu) with footprint (mem)", async () => {
    const seen: string[] = [];
    const exec = async (file: string, args: string[]): Promise<string> => {
      seen.push(file);
      if (file === "ps") return psFixtureTwoApps();
      // footprint receives only the frontmost app's pids (MyApp 103 + its extension 104)
      const pids = args.filter((a) => /^\d+$/.test(a));
      expect(pids).toEqual(["103", "104"]);
      return footprintFor(pids);
    };
    const usage = await sampleUserApp(UDID, { exec, frontmostPid: async () => 103 });
    expect(usage).toEqual({ cpuPct: 5, memBytes: 2_000_000 });
    expect(seen.sort()).toEqual(["footprint", "ps"]);
  });

  it("falls back to RSS bytes when footprint fails", async () => {
    const exec = async (file: string): Promise<string> => {
      if (file === "ps") return psFixture();
      throw new Error("footprint exited non-zero");
    };
    const usage = await sampleUserApp(UDID, { exec, frontmostPid: async () => 103 });
    expect(usage).toEqual({ cpuPct: 5, memBytes: (80000 + 20000) * 1024 });
  });

  it("returns null when ps fails", async () => {
    const exec = async (): Promise<string> => {
      throw new Error("ps exited non-zero");
    };
    expect(await sampleUserApp(UDID, { exec, frontmostPid: async () => undefined })).toBeNull();
  });
});

describe("MetricsSampler", () => {
  function fakeClock(step = 1000): () => number {
    let t = 0;
    return () => {
      const v = t;
      t += step;
      return v;
    };
  }

  it("exposes meta (schema, udid, hostCores, interval)", () => {
    const sampler = new MetricsSampler({ udid: UDID, intervalMs: 500, hostCores: 8 });
    expect(sampler.meta).toEqual({
      schemaVersion: 1,
      udid: UDID,
      hostCores: 8,
      sampleIntervalMs: 500,
    });
  });

  it("emits samples with timestamps relative to the sampler start", async () => {
    const readings = [
      { cpuPct: 10, memBytes: 100 },
      { cpuPct: 30, memBytes: 400 },
      { cpuPct: 20, memBytes: 250 },
    ];
    let i = 0;
    const sampler = new MetricsSampler({
      udid: UDID,
      sample: async () => readings[i++]!,
      now: fakeClock(),
      hostCores: 8,
    });
    const got: MetricSample[] = [];
    sampler.onSample((s) => got.push(s));

    await sampler.tickOnce();
    await sampler.tickOnce();
    await sampler.tickOnce();

    expect(got).toEqual([
      { t: 1000, cpuPct: 10, memBytes: 100 },
      { t: 2000, cpuPct: 30, memBytes: 400 },
      { t: 3000, cpuPct: 20, memBytes: 250 },
    ]);
    sampler.stop();
  });

  it("skips a tick when the sim isn't up (null reading)", async () => {
    const sampler = new MetricsSampler({
      udid: UDID,
      sample: async () => null,
      now: fakeClock(),
      hostCores: 8,
    });
    const got: MetricSample[] = [];
    sampler.onSample((s) => got.push(s));
    expect(await sampler.tickOnce()).toBeNull();
    expect(got).toHaveLength(0);
  });
});

describe("createMetricsSamplerCache", () => {
  it("shares one sampler across subscribers for the same udid and stops it on last unsubscribe", () => {
    const built: MetricsSampler[] = [];
    const cache = createMetricsSamplerCache((udid) => {
      const s = new MetricsSampler({ udid, sample: async () => null, hostCores: 8 });
      built.push(s);
      return s;
    });

    const a = cache.subscribe(UDID, () => {});
    const b = cache.subscribe(UDID, () => {});
    expect(built).toHaveLength(1); // one shared sampler
    expect(a.meta.udid).toBe(UDID);

    a.unsubscribe();
    expect(built[0]!.listenerCount).toBe(1); // still alive for b
    b.unsubscribe();

    // A fresh subscribe after the last leaves builds a new sampler.
    cache.subscribe(UDID, () => {});
    expect(built).toHaveLength(2);
  });

  it("fans one sample out to every subscriber", async () => {
    let sampler!: MetricsSampler;
    const cache = createMetricsSamplerCache((udid) => {
      sampler = new MetricsSampler({ udid, sample: async () => ({ cpuPct: 5, memBytes: 9 }), now: (() => { let t = 0; return () => (t += 1000); })(), hostCores: 8 });
      return sampler;
    });
    const seen: number[] = [];
    cache.subscribe(UDID, () => seen.push(1));
    cache.subscribe(UDID, () => seen.push(2));
    await sampler.tickOnce();
    expect(seen.sort()).toEqual([1, 2]);
  });
});
