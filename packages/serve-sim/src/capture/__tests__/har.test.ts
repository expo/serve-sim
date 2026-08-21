import { describe, expect, it } from "bun:test";

import {
  HarAccumulator,
  cookiesFromHeader,
  harAbsoluteUrl,
  harFromStore,
  harTimings,
  isHarEntryCompliant,
  parseFinishedCaptureRequest,
  toHarEntry,
} from "../har";
import { CaptureStore } from "../store";

const req = {
  id: "r1",
  method: "GET",
  url: "https://example.com/a?x=1#frag",
  status: 200,
  mimeType: "application/json",
  requestBytes: 0,
  responseBytes: 12,
  startedAt: 100,
  ttfbMs: 10,
  durationMs: 25,
  failure: null,
};

describe("HAR 1.2 helpers", () => {
  it("strips fragments from request URLs", () => {
    expect(harAbsoluteUrl("https://example.com/a?x=1#frag")).toBe("https://example.com/a?x=1");
  });

  it("parses Cookie and Set-Cookie headers", () => {
    expect(cookiesFromHeader("a=1; b=2", "request")).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ]);
    expect(cookiesFromHeader("session=abc; Path=/; HttpOnly", "response")).toEqual([
      { name: "session", value: "abc" },
    ]);
  });

  it("keeps send/wait/receive non-negative and time == sum", () => {
    const withTtfb = harTimings(req);
    expect(withTtfb.timings.send).toBe(0);
    expect(withTtfb.timings.wait).toBe(10);
    expect(withTtfb.timings.receive).toBe(15);
    expect(withTtfb.time).toBe(25);

    const durationOnly = harTimings({ ...req, ttfbMs: null });
    expect(durationOnly.timings.wait).toBe(25);
    expect(durationOnly.timings.receive).toBe(0);
    expect(durationOnly.time).toBe(25);

    const pending = harTimings({ ...req, ttfbMs: null, durationMs: null });
    expect(pending.timings.send).toBe(0);
    expect(pending.timings.wait).toBe(0);
    expect(pending.timings.receive).toBe(0);
    expect(pending.time).toBe(0);
  });

  it("clamps wait when ttfb exceeds duration", () => {
    const { timings, time } = harTimings({ ...req, ttfbMs: 40, durationMs: 25 });
    expect(timings.wait).toBe(25);
    expect(timings.receive).toBe(0);
    expect(time).toBe(25);
  });
});

describe("toHarEntry", () => {
  it("maps method, url, status, and timings", () => {
    const entry = toHarEntry(req, null, Date.parse("2026-01-01T00:00:00.000Z"));
    expect(entry.request.method).toBe("GET");
    expect(entry.request.url).toBe("https://example.com/a?x=1");
    expect(entry.request.queryString).toEqual([{ name: "x", value: "1" }]);
    expect(entry.response.status).toBe(200);
    expect(entry.response.statusText).toBe("OK");
    expect(entry.timings.wait).toBe(10);
    expect(entry.timings.receive).toBe(15);
    expect(entry.timings.send).toBe(0);
    expect(entry.time).toBe(25);
    expect(isHarEntryCompliant(entry)).toBe(true);
  });

  it("includes bodies, cookies, and redirectURL when provided", () => {
    const entry = toHarEntry(req, {
      requestHeaders: { accept: "application/json", cookie: "sid=1" },
      responseHeaders: {
        "content-type": "application/json",
        "set-cookie": "sid=1; Path=/",
        location: "https://example.com/b",
      },
      requestBody: null,
      responseBody: '{"ok":true}',
      requestTruncated: false,
      responseTruncated: false,
      requestBinary: false,
      responseBinary: false,
    });
    expect(entry.request.headers).toEqual([
      { name: "accept", value: "application/json" },
      { name: "cookie", value: "sid=1" },
    ]);
    expect(entry.request.cookies).toEqual([{ name: "sid", value: "1" }]);
    expect(entry.response.cookies).toEqual([{ name: "sid", value: "1" }]);
    expect(entry.response.redirectURL).toBe("https://example.com/b");
    expect(entry.response.content.text).toBe('{"ok":true}');
    expect(isHarEntryCompliant(entry)).toBe(true);
  });

  it("never emits negative required timings for in-flight rows", () => {
    const entry = toHarEntry(
      { ...req, status: null, ttfbMs: null, durationMs: null },
      null,
      Date.parse("2026-01-01T00:00:00.000Z"),
    );
    expect(entry.timings.send).toBeGreaterThanOrEqual(0);
    expect(entry.timings.wait).toBeGreaterThanOrEqual(0);
    expect(entry.timings.receive).toBeGreaterThanOrEqual(0);
    expect(isHarEntryCompliant(entry)).toBe(true);
  });
});

describe("HarAccumulator", () => {
  it("accumulates finished frames and survives a store-sized window", () => {
    const acc = new HarAccumulator("1.2.3");
    for (let i = 0; i < 600; i++) {
      acc.upsert({
        ...req,
        id: `r${i}`,
        url: `https://example.com/${i}`,
      });
    }
    expect(acc.size).toBe(600);
    const har = acc.toHar();
    const [first] = har.log.entries;
    if (first === undefined) throw new Error("expected at least one HAR entry");
    expect(first.request.url).toBe("https://example.com/0");
    expect(har.log.creator.version).toBe("1.2.3");
    expect(har.log.version).toBe("1.2");
    for (const entry of har.log.entries) {
      expect(isHarEntryCompliant(entry)).toBe(true);
    }
  });

  it("sorts entries by startedDateTime", () => {
    const acc = new HarAccumulator();
    const t0 = Date.parse("2026-01-01T00:00:02.000Z");
    const t1 = Date.parse("2026-01-01T00:00:01.000Z");
    acc.upsert({ ...req, id: "late", url: "https://example.com/late" });
    // Force wall starts by clearing and using known order via sequential upserts with delays —
    // wallStart is set on first upsert from Date.now(); override by building via toHarEntry path:
    (acc as unknown as { wallStart: Map<string, number>; entries: Map<string, unknown> }).wallStart.set(
      "late",
      t0,
    );
    (acc as unknown as { wallStart: Map<string, number> }).wallStart.set("early", t1);
    acc.upsert({ ...req, id: "late", url: "https://example.com/late" });
    acc.upsert({ ...req, id: "early", url: "https://example.com/early" });
    const urls = acc.toHar().log.entries.map((e) => e.request.url);
    expect(urls).toEqual(["https://example.com/early", "https://example.com/late"]);
  });

  it("evicts oldest entries when the cap is hit", () => {
    const acc = new HarAccumulator("1.2.3", 3);
    for (let i = 0; i < 5; i++) {
      acc.upsert({ ...req, id: `r${i}`, url: `https://example.com/${i}` });
    }
    expect(acc.size).toBe(3);
    expect(acc.toHar().log.entries.map((e) => e.request.url)).toEqual([
      "https://example.com/2",
      "https://example.com/3",
      "https://example.com/4",
    ]);
  });

  it("parses finished SSE payloads for body fetch", () => {
    expect(parseFinishedCaptureRequest(JSON.stringify({ type: "started", request: req }))).toBeNull();
    expect(parseFinishedCaptureRequest(JSON.stringify({ type: "cleared" }))).toBeNull();
    const finished = parseFinishedCaptureRequest(
      JSON.stringify({ type: "finished", request: { ...req, status: 200 } }),
    );
    expect(finished?.id).toBe("r1");
    expect(finished?.status).toBe(200);
  });
});

describe("harFromStore", () => {
  it("builds a snapshot of the current window with bodies", () => {
    const store = new CaptureStore();
    const id = store.start("POST", "https://example.com/upload");
    store.update(id, { status: 201, durationMs: 5, requestBytes: 3, responseBytes: 2 }, true);
    store.setBody(id, {
      requestHeaders: { "content-type": "text/plain" },
      responseHeaders: {},
      requestBody: "hi!",
      responseBody: "ok",
      requestTruncated: false,
      responseTruncated: false,
      requestBinary: false,
      responseBinary: false,
    });

    const har = harFromStore(store.list(), (rid) => store.body(rid));
    expect(har.log.entries).toHaveLength(1);
    const [entry] = har.log.entries;
    if (entry === undefined) throw new Error("expected one HAR entry");
    expect(entry.request.postData?.text).toBe("hi!");
    expect(entry.request.postData?.params).toEqual([]);
    expect(entry.response.status).toBe(201);
    expect(entry.response.statusText).toBe("Created");
    expect(isHarEntryCompliant(entry)).toBe(true);
  });
});
