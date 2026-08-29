import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { IncomingMessage, ServerResponse } from "http";
import { handleCrashReportRequest, handleCrashesRequest } from "../../middleware";
import { inProcessServeSimState } from "../../state";
import { createCrashRuntime } from "../runtime";
import type { CrashRuntime } from "../runtime";

const UDID = "CD26E7DF-F2CE-4DCB-B950-2F062DE3FBB3";

function bundleRoot(udid: string): string {
  return (
    `/Users/USER/Library/Developer/CoreSimulator/Devices/${udid}` +
    "/data/Containers/Bundle/Application/9E92F5F8/Demo.app"
  );
}

function ips({
  udid = UDID,
  symbol = "AppDelegate.boot()",
  capturedAt = "2026-08-04 23:14:07.8433 -0700",
}: {
  udid?: string;
  symbol?: string;
  capturedAt?: string;
} = {}): string {
  const root = bundleRoot(udid);
  const header = {
    app_name: "Demo",
    platform: 7,
    bundleID: "com.example.demo",
    bug_type: "309",
    incident_id: "INC-1",
  };
  const body = {
    procName: "Demo",
    procPath: `${root}/Demo`,
    pid: 42,
    captureTime: capturedAt,
    exception: { type: "EXC_CRASH", signal: "SIGABRT" },
    termination: { indicator: "Abort trap: 6" },
    faultingThread: 0,
    usedImages: [{ name: "Demo", path: `${root}/Demo` }],
    threads: [{ triggered: true, frames: [{ imageIndex: 0, imageOffset: 1, symbol }] }],
  };
  return `${JSON.stringify(header)}\n${JSON.stringify(body)}\n`;
}

type FakeRes = ServerResponse & {
  statusCode_: number;
  headers_: Record<string, string>;
  body_: string;
  destroyStream: () => void;
};

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { headers }) as unknown as IncomingMessage;
}

function fakeRes(): FakeRes {
  const res = {
    statusCode_: 0,
    headers_: {} as Record<string, string>,
    body_: "",
    destroyed: false,
    writableEnded: false,
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode_ = status;
      if (headers) res.headers_ = headers;
      return res;
    },
    write(chunk: string) {
      res.body_ += chunk;
      return true;
    },
    end(chunk?: string) {
      if (chunk) res.body_ += chunk;
      res.writableEnded = true;
      return res;
    },
    destroyStream() {
      res.destroyed = true;
    },
  };
  return res as unknown as FakeRes;
}

const state = inProcessServeSimState(UDID, 4000);

async function runtimeWithCrash(): Promise<CrashRuntime> {
  let emit: (eventType: string, filename: string | null) => void = () => {};
  const runtime = createCrashRuntime({
    reportsDir: "/reports",
    ensureDir: () => {},
    watchDir: (_dir, listener) => {
      emit = listener;
      return { close: () => {} };
    },
    readReport: async () => ips(),
    readDir: async () => [],
    statFile: async () => ({ mtimeMs: 0 }),
    onError: () => {},
  });
  runtime.start();
  emit("rename", "Demo-1.ips");
  await new Promise((resolve) => setTimeout(resolve, 0));
  return runtime;
}

async function runtimeWithRepeat(): Promise<CrashRuntime> {
  let emit: (eventType: string, filename: string | null) => void = () => {};
  const runtime = createCrashRuntime({
    reportsDir: "/reports",
    ensureDir: () => {},
    watchDir: (_dir, listener) => {
      emit = listener;
      return { close: () => {} };
    },
    readReport: async (path) =>
      path.endsWith("Demo-2.ips")
        ? ips({ capturedAt: "2026-08-04 23:15:07.8433 -0700" })
        : ips(),
    readDir: async () => [],
    statFile: async () => ({ mtimeMs: 0 }),
    onError: () => {},
  });
  runtime.start();
  emit("rename", "Demo-1.ips");
  await new Promise((resolve) => setTimeout(resolve, 0));
  emit("rename", "Demo-2.ips");
  await new Promise((resolve) => setTimeout(resolve, 0));
  return runtime;
}

describe("handleCrashesRequest", () => {
  test("404s when there is no device", () => {
    const res = fakeRes();
    handleCrashesRequest(fakeReq(), res, null);
    expect(res.statusCode_).toBe(404);
    expect(JSON.parse(res.body_).error).toContain("No serve-sim device");
  });

  test("returns JSON with the crash list and collection meta", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    handleCrashesRequest(fakeReq(), res, state, runtime);

    expect(res.statusCode_).toBe(200);
    expect(res.headers_["Content-Type"]).toBe("application/json");
    const payload = JSON.parse(res.body_);
    expect(payload.meta.status).toBe("watching");
    expect(payload.meta.reportDelaySeconds).toBeGreaterThan(0);
    expect(payload.crashes).toHaveLength(1);
    expect(payload.crashes[0].culpritFrame).toBe("Demo AppDelegate.boot()");
    expect(payload.crashes[0].logTail).toBeUndefined();
    expect(payload.crashes[0].logTailLines).toBe(0);
    expect(payload.crashes[0].occurrenceCount).toBe(1);
    expect(payload.crashes[0].occurrenceTimes).toEqual([
      {
        capturedAtMs: payload.crashes[0].capturedAtMs,
        capturedAt: payload.crashes[0].capturedAt,
        rawPath: payload.crashes[0].rawPath,
      },
    ]);
  });

  test("explains itself when collection is unavailable, with an empty list", () => {
    const runtime = createCrashRuntime({
      reportsDir: "/reports",
      ensureDir: () => {
        throw new Error("EPERM");
      },
      watchDir: () => ({ close: () => {} }),
      onError: () => {},
    });
    runtime.start();

    const res = fakeRes();
    handleCrashesRequest(fakeReq(), res, state, runtime);

    const payload = JSON.parse(res.body_);
    expect(payload.crashes).toEqual([]);
    expect(payload.meta.status).toBe("unavailable");
    expect(payload.meta.statusError).toContain("not being collected");
  });

  test("streams SSE with meta before the replayed backlog", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    handleCrashesRequest(fakeReq({ accept: "text/event-stream" }), res, state, runtime);

    expect(res.headers_["Content-Type"]).toBe("text/event-stream");
    const metaAt = res.body_.indexOf('"type":"meta"');
    const crashAt = res.body_.indexOf('"type":"crash"');
    expect(metaAt).toBeGreaterThanOrEqual(0);
    expect(crashAt).toBeGreaterThan(metaAt);
  });

  test("does not open a stream for a client that already went away", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    res.destroyStream();

    handleCrashesRequest(fakeReq({ accept: "text/event-stream" }), res, state, runtime);

    expect(res.statusCode_).toBe(0);
    expect(res.body_).toBe("");
  });
});

describe("handleCrashReportRequest", () => {
  test("404s for an unknown id, and blames the id not the device", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, state, "nope", null, runtime);
    expect(res.statusCode_).toBe(404);
    expect(JSON.parse(res.body_).error).toContain("No crash with that id");
  });

  test("404s when there is no device, and says so", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, null, "INC-1", null, runtime);
    expect(res.statusCode_).toBe(404);
    expect(JSON.parse(res.body_).error).toContain("No serve-sim device");
  });

  test("returns the record and the full report", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", null, runtime, async () => "RAW IPS");

    expect(res.statusCode_).toBe(200);
    const payload = JSON.parse(res.body_);
    expect(payload.record.id).toBe("INC-1");
    expect(payload.record.logTailLines).toBe(0);
    expect(payload.occurrence.logTail).toEqual([]);
    expect(payload.occurrence.frames).toEqual([
      { image: "Demo", symbol: "AppDelegate.boot()", imageOffset: 1, appOwned: true },
    ]);
    expect(payload.report).toBe("RAW IPS");
    expect(payload.reportError).toBeNull();
  });

  test("serves the newest occurrence when none is asked for", async () => {
    const runtime = await runtimeWithRepeat();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", null, runtime, async (path) => path);

    const payload = JSON.parse(res.body_);
    expect(payload.record.count).toBe(2);
    expect(payload.occurrence).toMatchObject({ index: 1, total: 2 });
    expect(payload.record.occurrenceTimes).toEqual([
      {
        capturedAtMs: Date.parse("2026-08-04 23:14:07.8433 -0700"),
        capturedAt: "2026-08-04 23:14:07.8433 -0700",
        rawPath: "/reports/Demo-1.ips",
      },
      {
        capturedAtMs: Date.parse("2026-08-04 23:15:07.8433 -0700"),
        capturedAt: "2026-08-04 23:15:07.8433 -0700",
        rawPath: "/reports/Demo-2.ips",
      },
    ]);
    expect(payload.report).toBe("/reports/Demo-2.ips");
  });

  test("serves an older occurrence on request", async () => {
    const runtime = await runtimeWithRepeat();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", "0", runtime, async (path) => path);

    const payload = JSON.parse(res.body_);
    expect(payload.occurrence).toMatchObject({ index: 0, total: 2 });
    expect(payload.report).toBe("/reports/Demo-1.ips");
  });

  test("rejects an occurrence outside the retained window", async () => {
    const runtime = await runtimeWithRepeat();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", "7", runtime);

    expect(res.statusCode_).toBe(400);
    expect(JSON.parse(res.body_).error).toContain("0-1");
  });

  test("keeps the summary and explains a report file that has been retired", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", null, runtime, async () => {
      throw new Error("ENOENT");
    });

    expect(res.statusCode_).toBe(200);
    const payload = JSON.parse(res.body_);
    expect(payload.record.id).toBe("INC-1");
    expect(payload.report).toBeNull();
    expect(payload.reportError).toContain("Retired");
  });
});
