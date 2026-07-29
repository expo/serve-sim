import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { IncomingMessage, ServerResponse } from "http";

import { createCaptureSessionCache } from "../capture-session";
import { type CaptureProxy } from "../mitm-engine";
import { handleCaptureBodyRequest, handleNetworkCaptureRequest } from "../middleware";
import { inProcessServeSimState } from "../state";

/**
 * Unit tests for the `/network-capture` routes, driven with a fake req/res and a session cache whose
 * proxy and trust install are stubbed — so they run without opening sockets or touching a simulator.
 */

function createFakeReq(): { req: IncomingMessage; close: () => void } {
  const req = Object.assign(new EventEmitter(), { headers: {} });
  return { req: req as unknown as IncomingMessage, close: () => req.emit("close") };
}

function createFakeRes(): { res: ServerResponse; writes: string[]; status: () => number } {
  const writes: string[] = [];
  let statusCode = 0;
  let ended = false;
  const res = {
    writeHead(status: number) {
      statusCode = status;
      return res;
    },
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk !== undefined) writes.push(chunk);
      ended = true;
      return res;
    },
    get writableEnded() {
      return ended;
    },
  };
  return { res: res as unknown as ServerResponse, writes, status: () => statusCode };
}

/** A cache that reports a fixed proxy address and touches nothing on the device. */
function stubCache() {
  const closed: string[] = [];
  const cache = createCaptureSessionCache({
    startProxy: async () =>
      ({
        address: "127.0.0.1:9999",
        caPem: async () => "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n",
        close: async () => void closed.push("x"),
      }) as CaptureProxy,
    trustCa: async () => {},
    targetApp: async () => "com.example.app",
    injection: { attach: async () => {} },
    teardownGraceMs: 0,
  });
  return { cache, closed };
}

const dataFrames = (writes: string[]): string[] => writes.filter((w) => w.startsWith("data:"));

describe("handleNetworkCaptureRequest", () => {
  test("responds 404 for an unknown device without starting a session", () => {
    const { cache } = stubCache();
    const { req } = createFakeReq();
    const { res, status } = createFakeRes();

    handleNetworkCaptureRequest(req, res, null, cache, []);

    expect(status()).toBe(404);
    expect(cache.storeFor("anything")).toBeNull();
  });

  test("writes a meta frame carrying the proxy address once the session is ready", async () => {
    const { cache } = stubCache();
    const { req, close } = createFakeReq();
    const { res, writes } = createFakeRes();
    const state = inProcessServeSimState("UDID-1", 4000);

    handleNetworkCaptureRequest(req, res, state, cache, []);
    await cache.whenReady("UDID-1");
    await Promise.resolve();

    const metaFrame = writes.find((w) => w.startsWith("event: meta"));
    expect(metaFrame).toBeDefined();
    const meta = JSON.parse(metaFrame!.slice("event: meta\ndata:".length).trim());
    expect(meta.udid).toBe("UDID-1");
    expect(meta.proxyAddress).toBe("127.0.0.1:9999");

    close();
  });

  test("streams captured requests to the subscriber as started/finished frames", async () => {
    const { cache } = stubCache();
    const { req, close } = createFakeReq();
    const { res, writes } = createFakeRes();
    const state = inProcessServeSimState("UDID-1", 4000);

    handleNetworkCaptureRequest(req, res, state, cache, []);
    await cache.whenReady("UDID-1");

    const store = cache.storeFor("UDID-1")!;
    const id = store.start("GET", "https://example.com/a");
    store.update(id, { status: 200, durationMs: 5 }, /* settled */ true);

    const frames = dataFrames(writes).map((w) => JSON.parse(w.slice("data:".length).trim()));
    expect(frames.map((f) => f.type)).toEqual(["started", "finished"]);
    expect(frames[1].request.url).toBe("https://example.com/a");
    expect(frames[1].request.status).toBe(200);

    close();
  });

  test("replays requests already recorded so a late viewer is not blind", async () => {
    const { cache } = stubCache();
    const first = createFakeReq();
    const firstRes = createFakeRes();
    const state = inProcessServeSimState("UDID-1", 4000);

    handleNetworkCaptureRequest(first.req, firstRes.res, state, cache, []);
    await cache.whenReady("UDID-1");
    cache.storeFor("UDID-1")!.start("GET", "https://example.com/early");

    // A second viewer joins after the fact and must still see the earlier request.
    const second = createFakeReq();
    const secondRes = createFakeRes();
    handleNetworkCaptureRequest(second.req, secondRes.res, state, cache, []);
    await cache.whenReady("UDID-1");
    await Promise.resolve();

    const urls = dataFrames(secondRes.writes)
      .map((w) => JSON.parse(w.slice("data:".length).trim()))
      .map((f) => f.request?.url);
    expect(urls).toContain("https://example.com/early");

    first.close();
    second.close();
  });

  test("shares one session across viewers and tears it down after the last closes", async () => {
    const { cache, closed } = stubCache();
    const state = inProcessServeSimState("UDID-1", 4000);
    const a = createFakeReq();
    const b = createFakeReq();

    handleNetworkCaptureRequest(a.req, createFakeRes().res, state, cache, []);
    handleNetworkCaptureRequest(b.req, createFakeRes().res, state, cache, []);
    await cache.whenReady("UDID-1");

    a.close();
    expect(cache.storeFor("UDID-1")).not.toBeNull(); // still live for b
    b.close();
    // Teardown puts the app back and removes the CA before closing the proxy, so it settles a tick later.
    await Bun.sleep(10);
    expect(cache.storeFor("UDID-1")).toBeNull();
    expect(closed).toHaveLength(1);
  });
});

describe("handleCaptureBodyRequest", () => {
  test("returns the stored headers and bodies for a captured request", async () => {
    const { cache } = stubCache();
    const state = inProcessServeSimState("UDID-1", 4000);
    const sub = createFakeReq();
    handleNetworkCaptureRequest(sub.req, createFakeRes().res, state, cache, []);
    await cache.whenReady("UDID-1");

    const store = cache.storeFor("UDID-1")!;
    const id = store.start("POST", "https://example.com/upload");
    store.setBody(id, {
      requestHeaders: { "content-type": "application/json" },
      responseHeaders: { "content-type": "application/json" },
      requestBody: '{"a":1}',
      responseBody: '{"ok":true}',
      requestTruncated: false,
      responseTruncated: true,
      requestBinary: false,
      responseBinary: false,
    });

    const { req } = createFakeReq();
    const { res, writes, status } = createFakeRes();
    handleCaptureBodyRequest(req, res, state, id, cache, []);

    expect(status()).toBe(200);
    const body = JSON.parse(writes.join(""));
    expect(body.requestBody).toBe('{"a":1}');
    expect(body.responseBody).toBe('{"ok":true}');
    expect(body.responseTruncated).toBe(true);

    sub.close();
  });

  test("404s for an unknown id, a device with no session, and no device at all", async () => {
    const { cache } = stubCache();
    const state = inProcessServeSimState("UDID-1", 4000);

    // No session running for this device yet.
    const noSession = createFakeRes();
    handleCaptureBodyRequest(createFakeReq().req, noSession.res, state, "r1", cache, []);
    expect(noSession.status()).toBe(404);

    // No device selected.
    const noDevice = createFakeRes();
    handleCaptureBodyRequest(createFakeReq().req, noDevice.res, null, "r1", cache, []);
    expect(noDevice.status()).toBe(404);

    // Session running, but the id was never recorded.
    const sub = createFakeReq();
    handleNetworkCaptureRequest(sub.req, createFakeRes().res, state, cache, []);
    await cache.whenReady("UDID-1");
    const unknown = createFakeRes();
    handleCaptureBodyRequest(createFakeReq().req, unknown.res, state, "r404", cache, []);
    expect(unknown.status()).toBe(404);
    sub.close();
  });
});
