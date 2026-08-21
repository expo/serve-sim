import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CAPTURE_ENTRIES_FILENAME,
  CAPTURE_HAR_FILENAME,
  CaptureDiskAccumulator,
  NETWORK_CAPTURE_FILENAME,
  sweepAbandonedCaptureDirs,
} from "../disk";
import { CaptureStore } from "../store";

function recordFinished(store: CaptureStore, url: string, body = "ok") {
  const id = store.start("GET", url);
  store.setBody(id, {
    requestHeaders: {},
    responseHeaders: { "content-type": "text/plain" },
    requestBody: null,
    responseBody: body,
    requestTruncated: false,
    responseTruncated: false,
    requestBinary: false,
    responseBinary: false,
  });
  store.update(
    id,
    {
      status: 200,
      mimeType: "text/plain",
      requestBytes: 0,
      responseBytes: body.length,
      ttfbMs: 1,
      durationMs: 2,
    },
    true,
  );
  return id;
}

describe("CaptureDiskAccumulator", () => {
  it("appends NDJSON events and rewrites a HAR while the session is live", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-disk-"));
    const store = new CaptureStore();
    const disk = new CaptureDiskAccumulator({
      dir,
      creatorVersion: "test",
      flushIntervalMs: 60_000,
    });

    try {
      const stop = disk.attach(store);
      recordFinished(store, "https://a.test/");
      await disk.flush();

      const events = readFileSync(join(dir, NETWORK_CAPTURE_FILENAME), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string });
      expect(events.some((e) => e.type === "session")).toBe(true);
      expect(events.some((e) => e.type === "started")).toBe(true);
      expect(events.some((e) => e.type === "finished")).toBe(true);

      const entryLines = readFileSync(join(dir, CAPTURE_ENTRIES_FILENAME), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(entryLines).toHaveLength(1);
      const [entryLine] = entryLines;
      if (entryLine === undefined) throw new Error("expected one NDJSON entry line");
      expect(JSON.parse(entryLine).request.url).toBe("https://a.test/");

      const har = JSON.parse(readFileSync(join(dir, CAPTURE_HAR_FILENAME), "utf8"));
      expect(har.log.entries).toHaveLength(1);
      const [harEntry] = har.log.entries;
      if (harEntry === undefined) throw new Error("expected one HAR entry");
      expect(harEntry.response.content.text).toBe("ok");
      expect(har.log.creator.version).toBe("test");

      await stop();
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps session HAR when the live store is cleared, until stop removes the dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-disk-clear-"));
    const store = new CaptureStore();
    const disk = new CaptureDiskAccumulator({ dir, flushIntervalMs: 60_000 });

    try {
      const stop = disk.attach(store);
      const id = store.start("GET", "https://a.test/");
      store.update(id, { status: 200, durationMs: 1 }, true);
      store.clear();
      await disk.flush();

      const har = JSON.parse(readFileSync(join(dir, CAPTURE_HAR_FILENAME), "utf8"));
      expect(har.log.entries).toHaveLength(1);

      const events = readFileSync(join(dir, NETWORK_CAPTURE_FILENAME), "utf8");
      expect(events).toContain('"type":"cleared"');

      await stop();
      expect(existsSync(dir)).toBe(false);
      expect(existsSync(join(dir, NETWORK_CAPTURE_FILENAME))).toBe(false);
      expect(existsSync(join(dir, CAPTURE_HAR_FILENAME))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts a clean NDJSON/HAR session on each attach", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-disk-reset-"));
    const staleEvents = join(dir, NETWORK_CAPTURE_FILENAME);
    writeFileSync(staleEvents, '{"type":"OLD"}\n');
    writeFileSync(join(dir, CAPTURE_HAR_FILENAME), '{"log":{"entries":[{"stale":true}]}}\n');
    writeFileSync(join(dir, CAPTURE_ENTRIES_FILENAME), '{"stale":true}\n');

    const store = new CaptureStore();
    const disk = new CaptureDiskAccumulator({ dir, flushIntervalMs: 60_000 });
    try {
      const stop = disk.attach(store);
      await disk.flush();
      const events = readFileSync(staleEvents, "utf8");
      expect(events).not.toContain('"type":"OLD"');
      expect(events).toContain('"type":"session"');
      expect(readFileSync(join(dir, CAPTURE_ENTRIES_FILENAME), "utf8")).toBe("");
      const har = JSON.parse(readFileSync(join(dir, CAPTURE_HAR_FILENAME), "utf8"));
      expect(har.log.entries).toEqual([]);
      await stop();
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evicts oldest durable HAR entries when the cap is hit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-disk-cap-"));
    const store = new CaptureStore();
    const disk = new CaptureDiskAccumulator({ dir, flushIntervalMs: 60_000, maxEntries: 3 });
    try {
      const stop = disk.attach(store);
      for (let i = 0; i < 5; i++) {
        const id = store.start("GET", `https://a.test/${i}`);
        store.update(id, { status: 200, durationMs: 1 }, true);
      }
      await disk.flush();
      expect(disk.size).toBe(3);
      const entryLines = readFileSync(join(dir, CAPTURE_ENTRIES_FILENAME), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(entryLines).toHaveLength(3);
      const har = JSON.parse(readFileSync(join(dir, CAPTURE_HAR_FILENAME), "utf8"));
      expect(har.log.entries).toHaveLength(3);
      // Newest-N ring (same as HarAccumulator): drop oldest via streamed NDJSON compact.
      expect(har.log.entries[0].request.url).toBe("https://a.test/2");
      expect(har.log.entries[2].request.url).toBe("https://a.test/4");
      await stop();
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes the artifact directory on stop even when nothing was recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-disk-empty-"));
    const store = new CaptureStore();
    const disk = new CaptureDiskAccumulator({ dir, flushIntervalMs: 60_000 });
    const stop = disk.attach(store);
    expect(existsSync(join(dir, NETWORK_CAPTURE_FILENAME))).toBe(true);
    expect(existsSync(join(dir, CAPTURE_HAR_FILENAME))).toBe(true);
    expect(existsSync(join(dir, CAPTURE_ENTRIES_FILENAME))).toBe(true);
    await stop();
    expect(existsSync(dir)).toBe(false);
  });
});

describe("sweepAbandonedCaptureDirs", () => {
  it("removes capture dirs no live session owns", () => {
    const removed: string[] = [];
    const swept = sweepAbandonedCaptureDirs(["KEEP-ME"], {
      list: () => [
        "capture-KEEP-ME",
        "capture-CRASHED-EARLIER",
        "capture-ANOTHER-DEAD-ONE",
        "server-KEEP-ME.json",
        "serve-sim-capture-abc123",
      ],
      remove: (dir: string) => void removed.push(dir.split("/").at(-1)!),
    });

    expect(swept).toBe(2);
    expect(removed).toEqual(["capture-CRASHED-EARLIER", "capture-ANOTHER-DEAD-ONE"]);
  });

  it("leaves state files and the proxy's own confdirs alone", () => {
    const removed: string[] = [];
    sweepAbandonedCaptureDirs([], {
      // A mitmproxy confdir is `serve-sim-capture-…`, which starts with neither prefix we own.
      list: () => ["server-X.json", "serve-sim-capture-xyz", "simcam"],
      remove: (dir: string) => void removed.push(dir),
    });

    expect(removed).toEqual([]);
  });

  it("survives a directory that cannot be removed", () => {
    const swept = sweepAbandonedCaptureDirs([], {
      list: () => ["capture-A", "capture-B"],
      remove: (dir: string) => {
        if (dir.endsWith("capture-A")) throw new Error("in use");
      },
    });

    // One failure must not stop the rest from being reclaimed.
    expect(swept).toBe(1);
  });
});
