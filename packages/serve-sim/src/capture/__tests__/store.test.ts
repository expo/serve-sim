import { describe, expect, test } from "bun:test";

import { CaptureStore, clampBody, type CaptureEvent } from "../store";

function collect(store: CaptureStore): CaptureEvent[] {
  const seen: CaptureEvent[] = [];
  store.subscribe((event) => seen.push(event));
  return seen;
}

describe("CaptureStore", () => {
  test("publishes a started frame up front and a finished frame once settled", () => {
    const store = new CaptureStore(() => 0);
    const seen = collect(store);

    const id = store.start("GET", "https://example.com/a");
    expect(seen.map((e) => e.type)).toEqual(["started"]);

    store.update(id, { status: 200, ttfbMs: 12 }); // in-flight patch: no frame yet
    expect(seen.map((e) => e.type)).toEqual(["started"]);

    store.update(id, { durationMs: 30 }, /* settled */ true);
    expect(seen.map((e) => e.type)).toEqual(["started", "finished"]);
    const finished = seen[1]!;
    if (finished.type !== "finished") throw new Error("expected a finished frame");
    expect(finished.request.status).toBe(200);
    expect(finished.request.durationMs).toBe(30);
  });

  test("starts a request with null status/timings so the UI can show it in flight", () => {
    const store = new CaptureStore(() => 5);
    const id = store.start("POST", "https://example.com/upload");
    const [request] = store.list();
    expect(request).toMatchObject({
      id,
      method: "POST",
      url: "https://example.com/upload",
      status: null,
      ttfbMs: null,
      durationMs: null,
      failure: null,
      startedAt: 5,
    });
  });

  test("keeps a failure reason for a request that never produced a status", () => {
    const store = new CaptureStore(() => 0);
    const id = store.start("GET", "https://pinned.example.com/");
    store.update(id, { failure: "certificate pinning", durationMs: 1 }, /* settled */ true);
    const [request] = store.list();
    expect(request!.status).toBeNull();
    expect(request!.failure).toBe("certificate pinning");
  });

  test("ignores updates for a request that has left the window", () => {
    const store = new CaptureStore(() => 0);
    const seen: CaptureEvent[] = [];
    store.subscribe((event) => seen.push(event));

    store.update("r999", { status: 200 }, true);

    // No resurrected record, and no `finished` for a request no viewer has ever seen started.
    expect(store.list()).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  test("serves bodies separately from the request list and drops them with the request", () => {
    const store = new CaptureStore(() => 0);
    const id = store.start("GET", "https://example.com/a");
    store.setBody(id, {
      requestHeaders: { accept: "*/*" },
      responseHeaders: { "content-type": "application/json" },
      requestBody: null,
      responseBody: '{"ok":true}',
      requestTruncated: false,
      responseTruncated: false,
      requestBinary: false,
      responseBinary: false,
    });
    expect(store.body(id)?.responseBody).toBe('{"ok":true}');

    store.clear();
    expect(store.body(id)).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  test("refuses a body for an unknown request", () => {
    const store = new CaptureStore(() => 0);
    store.setBody("r404", {
      requestHeaders: {},
      responseHeaders: {},
      requestBody: null,
      responseBody: "x",
      requestTruncated: false,
      responseTruncated: false,
      requestBinary: false,
      responseBinary: false,
    });
    expect(store.body("r404")).toBeNull();
  });

  test("evicts the oldest requests once the window is full", () => {
    const store = new CaptureStore(() => 0);
    for (let i = 0; i < 520; i++) store.start("GET", `https://example.com/${i}`);
    const list = store.list();
    expect(list).toHaveLength(500);
    // The window slid: the earliest urls are gone, the newest are kept.
    expect(list[0]!.url).toBe("https://example.com/20");
    expect(list.at(-1)!.url).toBe("https://example.com/519");
  });

  test("emits a cleared frame and keeps notifying after a throwing subscriber", () => {
    const store = new CaptureStore(() => 0);
    store.subscribe(() => {
      throw new Error("subscriber blew up");
    });
    const seen = collect(store);
    store.start("GET", "https://example.com/a");
    store.clear();
    expect(seen.map((e) => e.type)).toEqual(["started", "cleared"]);
  });

  test("stops publishing after unsubscribe", () => {
    const store = new CaptureStore(() => 0);
    const seen: CaptureEvent[] = [];
    const off = store.subscribe((event) => seen.push(event));
    store.start("GET", "https://example.com/a");
    off();
    store.start("GET", "https://example.com/b");
    expect(seen).toHaveLength(1);
    expect(store.listenerCount).toBe(0);
  });
});

describe("clampBody", () => {
  test("reports no body for an empty capture", () => {
    expect(clampBody([])).toEqual({ text: null, truncated: false });
  });

  test("passes a small body through untouched", () => {
    expect(clampBody([Buffer.from("hello ") , Buffer.from("world")])).toEqual({
      text: "hello world",
      truncated: false,
    });
  });

  test("cuts an oversized body and flags it, rather than dropping or keeping all of it", () => {
    const { text, truncated } = clampBody([Buffer.alloc(600 * 1024, 0x61)]);
    expect(truncated).toBe(true);
    expect(text).toHaveLength(512 * 1024);
  });
});

describe("CaptureStore throughput", () => {
  /** A clock the test advances, so the trailing window can be exercised deterministically. */
  function clocked() {
    let ms = 0;
    const store = new CaptureStore(() => ms);
    return { store, advance: (by: number) => (ms += by) };
  }

  test("reports nothing before any traffic", () => {
    const { store } = clocked();
    expect(store.throughput()).toEqual({ netInBytesPerSec: 0, netOutBytesPerSec: 0 });
  });

  test("sums bytes over the trailing second, keeping directions apart", () => {
    const { store } = clocked();
    store.noteTraffic(1000, 0);
    store.noteTraffic(500, 200);
    expect(store.throughput()).toEqual({ netInBytesPerSec: 1500, netOutBytesPerSec: 200 });
  });

  test("still counts traffic recorded across several slices of the window", () => {
    const { store, advance } = clocked();
    store.noteTraffic(400, 0);
    advance(300);
    store.noteTraffic(600, 0);
    advance(300);
    store.noteTraffic(0, 250);
    expect(store.throughput()).toEqual({ netInBytesPerSec: 1000, netOutBytesPerSec: 250 });
  });

  test("drops traffic older than the window, so a finished burst decays to zero", () => {
    const { store, advance } = clocked();
    store.noteTraffic(5000, 1000);
    expect(store.throughput().netInBytesPerSec).toBe(5000);
    advance(1500); // past the one-second window
    expect(store.throughput()).toEqual({ netInBytesPerSec: 0, netOutBytesPerSec: 0 });
  });

  test("keeps only the recent part of a window that is still filling", () => {
    const { store, advance } = clocked();
    store.noteTraffic(800, 0); // ages out
    advance(1200);
    store.noteTraffic(300, 0); // still inside the window
    expect(store.throughput()).toEqual({ netInBytesPerSec: 300, netOutBytesPerSec: 0 });
  });

  test("reports a long transfer as a rate, not as a spike when it finishes", () => {
    const { store, advance } = clocked();
    advance(30_000);
    // 10MB that took 30s is 333KB/s. Charging it all to the settle instant would read 10MB/s for one
    // second and zero either side, which is what made the graph spiky.
    store.noteTraffic(10_000_000, 0, 30_000);
    expect(store.throughput().netInBytesPerSec).toBe(333_333);
  });

  test("keeps a short transfer whole, since it fits inside the window", () => {
    const { store, advance } = clocked();
    advance(50);
    store.noteTraffic(5_000, 0, 50);
    expect(store.throughput()).toEqual({ netInBytesPerSec: 5_000, netOutBytesPerSec: 0 });
  });

  test("drops traffic that has aged out, so throughput is a rate and not a lifetime total", () => {
    const { store, advance } = clocked();
    // The window is 10 buckets of 100ms. Write one bucket's worth, 50 buckets apart, so an
    // implementation that never prunes reports the sum of all 50 instead of the last few.
    for (let i = 0; i < 50; i++) {
      store.noteTraffic(1_000, 500);
      advance(100);
    }

    const { netInBytesPerSec, netOutBytesPerSec } = store.throughput();
    expect(netInBytesPerSec).toBeLessThanOrEqual(1_000 * 10);
    expect(netOutBytesPerSec).toBeLessThanOrEqual(500 * 10);
    expect(netInBytesPerSec).toBeGreaterThan(0);
  });

  test("charges headers to the memory cap and refunds them when the record is evicted", () => {
    const store = new CaptureStore(() => 0);
    const big = "x".repeat(200_000);
    const headerOnly = {
      requestHeaders: { "x-big": big },
      responseHeaders: { "x-big": big },
      requestBody: null,
      responseBody: null,
      requestTruncated: false,
      responseTruncated: false,
      requestBinary: false,
      responseBinary: false,
    };

    const ids: string[] = [];
    for (let i = 0; i < 600; i++) {
      const id = store.start("GET", `https://example.com/${i}`);
      ids.push(id);
      store.setBody(id, headerOnly);
    }

    // Headers are charged, so 400KB records fill the 16MB cap long before the 500-record limit.
    expect(ids.filter((id) => store.body(id) !== null).length).toBeLessThan(ids.length);
    // And refunded on eviction: without that, the cap fills once and the store refuses every body after,
    // while holding none — so the newest records, written after evictions began, must still have theirs.
    expect(ids.slice(-100).some((id) => store.body(id) !== null)).toBe(true);
  });

  test("charges bodies by byte, not by character", () => {
    const store = new CaptureStore(() => 0);
    // Four bytes per emoji, two UTF-16 units. Counting units undercharged multi-byte text 2x.
    const emoji = "\u{1F600}".repeat(5_000_000);
    const id = store.start("POST", "https://example.com/upload");
    store.setBody(id, {
      requestHeaders: {},
      responseHeaders: {},
      requestBody: emoji,
      responseBody: null,
      requestTruncated: false,
      responseTruncated: false,
      requestBinary: false,
      responseBinary: false,
    });

    // 10MB of code units but 20MB of bytes, so it must not fit under the 16MB cap.
    expect(store.body(id)).toBeNull();
  });
});
