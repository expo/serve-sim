import { describe, expect, it } from "bun:test";

import { CaptureStore, clampBody, type CaptureEvent } from "../capture-store";

function collect(store: CaptureStore): CaptureEvent[] {
  const seen: CaptureEvent[] = [];
  store.subscribe((event) => seen.push(event));
  return seen;
}

describe("CaptureStore", () => {
  it("publishes a started frame up front and a finished frame once settled", () => {
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

  it("starts a request with null status/timings so the UI can show it in flight", () => {
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

  it("keeps a failure reason for a request that never produced a status", () => {
    const store = new CaptureStore(() => 0);
    const id = store.start("GET", "https://pinned.example.com/");
    store.update(id, { failure: "certificate pinning", durationMs: 1 }, /* settled */ true);
    const [request] = store.list();
    expect(request!.status).toBeNull();
    expect(request!.failure).toBe("certificate pinning");
  });

  it("ignores updates for a request that has left the window", () => {
    const store = new CaptureStore(() => 0);
    expect(() => store.update("r999", { status: 200 }, true)).not.toThrow();
    expect(store.list()).toHaveLength(0);
  });

  it("serves bodies separately from the request list and drops them with the request", () => {
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
    // Bodies are not part of the streamed record.
    expect("responseBody" in store.list()[0]!).toBe(false);

    store.clear();
    expect(store.body(id)).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it("refuses a body for an unknown request", () => {
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

  it("evicts the oldest requests once the window is full", () => {
    const store = new CaptureStore(() => 0);
    for (let i = 0; i < 520; i++) store.start("GET", `https://example.com/${i}`);
    const list = store.list();
    expect(list).toHaveLength(500);
    // The window slid: the earliest urls are gone, the newest are kept.
    expect(list[0]!.url).toBe("https://example.com/20");
    expect(list.at(-1)!.url).toBe("https://example.com/519");
  });

  it("emits a cleared frame and keeps notifying after a throwing subscriber", () => {
    const store = new CaptureStore(() => 0);
    store.subscribe(() => {
      throw new Error("subscriber blew up");
    });
    const seen = collect(store);
    store.start("GET", "https://example.com/a");
    store.clear();
    expect(seen.map((e) => e.type)).toEqual(["started", "cleared"]);
  });

  it("stops publishing after unsubscribe", () => {
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
  it("reports no body for an empty capture", () => {
    expect(clampBody([])).toEqual({ text: null, truncated: false });
  });

  it("passes a small body through untouched", () => {
    expect(clampBody([Buffer.from("hello ") , Buffer.from("world")])).toEqual({
      text: "hello world",
      truncated: false,
    });
  });

  it("cuts an oversized body and flags it, rather than dropping or keeping all of it", () => {
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

  it("reports nothing before any traffic", () => {
    const { store } = clocked();
    expect(store.throughput()).toEqual({ in: 0, out: 0 });
  });

  it("sums bytes over the trailing second, keeping directions apart", () => {
    const { store } = clocked();
    store.noteTraffic(1000, 0);
    store.noteTraffic(500, 200);
    expect(store.throughput()).toEqual({ in: 1500, out: 200 });
  });

  it("still counts traffic recorded across several slices of the window", () => {
    const { store, advance } = clocked();
    store.noteTraffic(400, 0);
    advance(300);
    store.noteTraffic(600, 0);
    advance(300);
    store.noteTraffic(0, 250);
    expect(store.throughput()).toEqual({ in: 1000, out: 250 });
  });

  it("drops traffic older than the window, so a finished burst decays to zero", () => {
    const { store, advance } = clocked();
    store.noteTraffic(5000, 1000);
    expect(store.throughput().in).toBe(5000);
    advance(1500); // past the one-second window
    expect(store.throughput()).toEqual({ in: 0, out: 0 });
  });

  it("keeps only the recent part of a window that is still filling", () => {
    const { store, advance } = clocked();
    store.noteTraffic(800, 0); // ages out
    advance(1200);
    store.noteTraffic(300, 0); // still inside the window
    expect(store.throughput()).toEqual({ in: 300, out: 0 });
  });

  it("reports a long transfer as a rate, not as a spike when it finishes", () => {
    const { store, advance } = clocked();
    advance(30_000);
    // 10MB that took 30s is 333KB/s. Charging it all to the settle instant would read 10MB/s for one
    // second and zero either side, which is what made the graph spiky.
    store.noteTraffic(10_000_000, 0, 30_000);
    expect(store.throughput().in).toBe(333_333);
  });

  it("keeps a short transfer whole, since it fits inside the window", () => {
    const { store, advance } = clocked();
    advance(50);
    store.noteTraffic(5_000, 0, 50);
    expect(store.throughput()).toEqual({ in: 5_000, out: 0 });
  });

  it("bounds its bookkeeping regardless of how many writes arrive", () => {
    const { store, advance } = clocked();
    for (let i = 0; i < 2000; i++) {
      store.noteTraffic(1, 1);
      if (i % 100 === 0) advance(50);
    }
    // The window holds a fixed number of slices, so memory can't grow with traffic volume.
    expect(store.throughput().in).toBeGreaterThan(0);
    expect(store.throughput().in).toBeLessThanOrEqual(2000);
  });
});
