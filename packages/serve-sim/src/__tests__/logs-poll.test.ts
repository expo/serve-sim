import { describe, expect, test } from "bun:test";
import {
  logsSnapshotUrl,
  parseLogSnapshot,
  startLogsPoll,
  type LogSnapshotLine,
} from "../client/utils/logs-poll";

const raw = JSON.stringify({
  timestamp: "2026-08-28 12:54:11.123456-0700",
  processImagePath: "/SpringBoard.app/SpringBoard",
  eventMessage: "hello",
  messageType: "Default",
  processID: 1,
});

describe("logsSnapshotUrl", () => {
  test("asks for a JSON follow snapshot, not SSE", () => {
    const url = logsSnapshotUrl("/logs?device=UDID", 0);
    const params = new URL(url, "http://127.0.0.1").searchParams;
    expect(params.get("snapshot")).toBe("1");
    expect(params.get("follow")).toBe("1");
    expect(params.get("since")).toBeNull();
    expect(params.get("limit")).toBe("400");
    expect(params.get("envelope")).toBeNull();
  });

  test("resumes from a cursor with a larger page", () => {
    const url = logsSnapshotUrl("/.sim/logs?device=UDID", 12);
    const params = new URL(url, "http://127.0.0.1").searchParams;
    expect(params.get("since")).toBe("12");
    expect(params.get("limit")).toBe("800");
    expect(url.startsWith("/.sim/logs?")).toBe(true);
  });
});

describe("parseLogSnapshot", () => {
  test("keeps parseable lines and the server cursor", () => {
    const parsed = parseLogSnapshot({
      latestSeq: 4,
      lines: [
        { seq: 3, raw },
        { seq: 4, raw: "not-json" },
        { seq: 5 },
      ],
    });
    expect(parsed.latestSeq).toBe(4);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]?.seq).toBe(3);
    expect(parsed.lines[0]?.fields.message).toBe("hello");
  });

  test("treats a malformed payload as empty", () => {
    expect(parseLogSnapshot(null)).toEqual({ latestSeq: 0, lines: [] });
    expect(parseLogSnapshot("nope")).toEqual({ latestSeq: 0, lines: [] });
  });
});

describe("startLogsPoll", () => {
  // `simAuthHeaders` reads a bare `window`, which is a ReferenceError off the browser.
  function withPreviewWindow(): () => void {
    const globals = globalThis as { window?: unknown };
    globals.window = { __SIM_PREVIEW__: { execToken: "test-token" } };
    return () => delete globals.window;
  }

  test("delivers a live reply and advances the cursor", async () => {
    const restoreWindow = withPreviewWindow();
    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ lines: [{ seq: 7, raw }], latestSeq: 7 }), {
          headers: { "Content-Type": "application/json" },
        })
      )) as unknown as typeof fetch;

    const batches: LogSnapshotLine[][] = [];
    const errors: boolean[] = [];
    let since = 0;
    const stop = startLogsPoll("/logs", {
      getSince: () => since,
      setSince: (seq) => {
        since = seq;
      },
      onBatch: (lines) => batches.push(lines),
      onError: (errored) => errors.push(errored),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();
    globalThis.fetch = original;
    restoreWindow();

    expect(errors).toEqual([false]);
    expect(since).toBe(7);
    expect(batches.flat().map((line) => line.seq)).toEqual([7]);
  });

  test("reports a failed request without moving the cursor", async () => {
    const restoreWindow = withPreviewWindow();
    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(new Response("nope", { status: 503 }))) as unknown as typeof fetch;

    const errors: boolean[] = [];
    let since = 3;
    const stop = startLogsPoll("/logs", {
      getSince: () => since,
      setSince: (seq) => {
        since = seq;
      },
      onBatch: () => {},
      onError: (errored) => errors.push(errored),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    stop();
    globalThis.fetch = original;
    restoreWindow();

    expect(errors).toContain(true);
    expect(since).toBe(3);
  });

  test("rewinds when the server hands back a fresh buffer", async () => {
    const restoreWindow = withPreviewWindow();
    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ lines: [{ seq: 1, raw }], latestSeq: 1 }), {
          headers: { "Content-Type": "application/json" },
        })
      )) as unknown as typeof fetch;

    const batches: LogSnapshotLine[][] = [];
    let since = 5_000;
    const stop = startLogsPoll("/logs", {
      getSince: () => since,
      setSince: (seq) => {
        since = seq;
      },
      onBatch: (lines) => batches.push(lines),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();
    globalThis.fetch = original;
    restoreWindow();

    expect(since).toBe(0);
    expect(batches).toEqual([]);
  });

  test("drops a reply that lands after the caller stopped", async () => {
    const restoreWindow = withPreviewWindow();
    const original = globalThis.fetch;
    const replied = Promise.withResolvers<Response>();
    globalThis.fetch = (() => replied.promise) as unknown as typeof fetch;

    const batches: LogSnapshotLine[][] = [];
    let since = 0;
    const stop = startLogsPoll("/logs", {
      getSince: () => since,
      setSince: (seq) => {
        since = seq;
      },
      onBatch: (lines) => batches.push(lines),
    });

    stop();
    replied.resolve(
      new Response(JSON.stringify({ lines: [{ seq: 7, raw }], latestSeq: 7 }), {
        headers: { "Content-Type": "application/json" },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    globalThis.fetch = original;
    restoreWindow();

    expect(batches).toEqual([]);
    expect(since).toBe(0);
  });
});
