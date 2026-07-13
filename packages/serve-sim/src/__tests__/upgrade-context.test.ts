import { afterEach, describe, expect, test } from "bun:test";
import { createServer as createNetServer } from "net";
import { simMiddleware } from "../middleware";
import {
  hidSocketFromUpgrade,
  type UpgradeSocketHooks,
  type UpgradeSocketMessage,
  type UpgradeSocketPeer,
} from "../upgrade-context";
import type { HidSocket } from "../device-session";

// Hook-based WebSocket upgrades: the contract Expo CLI's DevTools plugin
// `context.upgrade(hooks)` implements. These tests drive the middleware with a
// fake context that mirrors the CLI's semantics — `upgrade()` returns a marker
// Response, and the hooks fire only if the middleware returned that marker.

const TOKEN = "upgrade-context-test-token";

function textMessage(data: string): UpgradeSocketMessage {
  const bytes = new TextEncoder().encode(data);
  return { isBinary: false, text: () => data, uint8Array: () => bytes };
}

function binaryMessage(bytes: Uint8Array): UpgradeSocketMessage {
  return {
    isBinary: true,
    text: () => new TextDecoder().decode(bytes),
    uint8Array: () => bytes,
  };
}

class FakePeer implements UpgradeSocketPeer {
  sent: unknown[] = [];
  closed = false;
  send(data: string | Uint8Array | ArrayBufferLike | object): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

function createFakeContext() {
  let hooks: UpgradeSocketHooks | undefined;
  const committed = new Set<Response>();
  return {
    context: {
      upgrade(h: UpgradeSocketHooks): Response {
        hooks = h;
        const response = new Response(null, { statusText: "Switching Protocols" });
        committed.add(response);
        return response;
      },
    },
    hooks: () => {
      if (!hooks) throw new Error("upgrade() was never called");
      return hooks;
    },
    upgraded: () => hooks !== undefined,
    isCommitted: (response: Response | null | undefined) =>
      response != null && committed.has(response),
  };
}

async function waitFor<T>(get: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function upgradeRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    headers: {
      host: new URL(url).host,
      connection: "Upgrade",
      upgrade: "websocket",
      ...headers,
    },
  });
}

function parseReplies(peer: FakePeer): Array<Record<string, unknown>> {
  return peer.sent
    .filter((data): data is string => typeof data === "string")
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

describe("exec-ws over context.upgrade", () => {
  test("authenticates and runs commands", async () => {
    const middleware = simMiddleware({ basePath: "/", execToken: TOKEN });
    const { context, hooks, isCommitted } = createFakeContext();

    const response = await middleware(upgradeRequest("http://localhost:8081/exec-ws"), context);
    expect(isCommitted(response)).toBe(true);

    const peer = new FakePeer();
    hooks().onopen?.(peer);
    hooks().onmessage?.(peer, textMessage(JSON.stringify({ token: TOKEN })));
    expect(parseReplies(peer)).toContainEqual({ ready: true });

    hooks().onmessage?.(
      peer,
      textMessage(JSON.stringify({ id: 1, command: "echo upgrade-context" })),
    );
    const reply = await waitFor(() => parseReplies(peer).find((r) => r.id === 1));
    expect(String(reply.stdout).trim()).toBe("upgrade-context");
    expect(reply.exitCode).toBe(0);
  });

  test("closes the peer on a bad token", async () => {
    const middleware = simMiddleware({ basePath: "/", execToken: TOKEN });
    const { context, hooks, isCommitted } = createFakeContext();

    const response = await middleware(upgradeRequest("http://localhost:8081/exec-ws"), context);
    expect(isCommitted(response)).toBe(true);

    const peer = new FakePeer();
    hooks().onopen?.(peer);
    hooks().onmessage?.(peer, textMessage(JSON.stringify({ token: "wrong" })));
    expect(peer.closed).toBe(true);
  });

  test("closes cross-origin upgrades", async () => {
    const middleware = simMiddleware({ basePath: "/", execToken: TOKEN });
    const { context, hooks } = createFakeContext();

    await middleware(
      upgradeRequest("http://localhost:8081/exec-ws", { origin: "http://evil.example" }),
      context,
    );

    // The handler closed the adapter before the handshake committed; the peer
    // must be closed as soon as it appears.
    const peer = new FakePeer();
    hooks().onopen?.(peer);
    expect(peer.closed).toBe(true);
  });
});

describe("upgrade routing", () => {
  test("declines upgrades to unknown paths without committing", async () => {
    const middleware = simMiddleware({ basePath: "/", execToken: TOKEN });
    const { context, isCommitted } = createFakeContext();

    const response = await middleware(upgradeRequest("http://localhost:8081/nope"), context);
    expect(response).toBeUndefined();
    expect(isCommitted(response)).toBe(false);
  });

  test("rejects helper HID upgrades for unknown devices with a plain 404", async () => {
    const middleware = simMiddleware({ basePath: "/", execToken: TOKEN });
    const { context, upgraded, isCommitted } = createFakeContext();

    const response = await middleware(
      upgradeRequest("http://localhost:8081/helper/NOT-A-BOOTED-DEVICE/ws"),
      context,
    );
    expect(response?.status).toBe(404);
    expect(isCommitted(response)).toBe(false);
    expect(upgraded()).toBe(false);
  });

  test("still serves plain HTTP requests when a context is passed", async () => {
    const middleware = simMiddleware({ basePath: "/", execToken: TOKEN });
    const { context, upgraded } = createFakeContext();

    const response = await middleware(
      new Request("http://localhost:8081/grid/api/memory", {
        headers: { host: "localhost:8081" },
      }),
      context,
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/json");
    // Crucially, upgrade() was never called — the host's throws for HTTP requests.
    expect(upgraded()).toBe(false);
  });
});

describe("hidSocketFromUpgrade", () => {
  test("attaches on open and adapts frames in both directions", () => {
    const { context, hooks } = createFakeContext();
    let attached: HidSocket | null = null;
    hidSocketFromUpgrade(context, (socket) => {
      attached = socket;
    });
    expect(attached).toBeNull();

    const peer = new FakePeer();
    hooks().onopen?.(peer);
    expect(attached).not.toBeNull();
    const hid = attached! as HidSocket;

    const received: Buffer[] = [];
    let closes = 0;
    hid.on("message", (data) => received.push(data));
    hid.on("close", () => closes++);
    hid.on("error", () => closes++);

    hooks().onmessage?.(peer, binaryMessage(new Uint8Array([0x03, 0x01, 0x02])));
    expect(received).toHaveLength(1);
    expect(Buffer.isBuffer(received[0])).toBe(true);
    expect([...received[0]!]).toEqual([0x03, 0x01, 0x02]);

    hid.send(Buffer.from([0x42]));
    expect(peer.sent).toHaveLength(1);

    hooks().onclose?.(peer, { code: 1000, reason: "" });
    expect(closes).toBe(2);
    // Frames after close must not reach the peer.
    hid.send(Buffer.from([0x43]));
    expect(peer.sent).toHaveLength(1);
  });
});

describe("devtools proxy over context.upgrade", () => {
  let cdp: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    cdp?.stop(true);
    cdp = null;
  });

  test("bridges frames to the inspect-webkit upstream, queueing until it opens", async () => {
    const cdpPort = await freePort();
    let cdpSawText = false;
    cdp = Bun.serve({
      hostname: "127.0.0.1",
      port: cdpPort,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/devtools/page/") && server.upgrade(req, { data: undefined })) {
          return undefined;
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message(ws, message) {
          cdpSawText = typeof message === "string";
          ws.send(`cdp:${message}`);
        },
      },
    });

    const middleware = simMiddleware({
      basePath: "/",
      execToken: TOKEN,
      inspectWebKitBridge: async () => ({
        port: cdpPort,
        cdpUrl: `http://127.0.0.1:${cdpPort}`,
        listTargets: async () => [],
      }),
    });
    const { context, hooks, isCommitted } = createFakeContext();

    const response = await middleware(
      upgradeRequest("http://localhost:8081/devtools/page/sim%3Apage%3A1"),
      context,
    );
    expect(isCommitted(response)).toBe(true);

    const peer = new FakePeer();
    hooks().onopen?.(peer);
    // Sent before the upstream connection opens — must be queued, not
    // dropped, and stay a *text* frame across the relay.
    hooks().onmessage?.(peer, textMessage("ping"));

    const echoed = await waitFor(() => peer.sent.find((data) => data === "cdp:ping"));
    expect(echoed).toBe("cdp:ping");
    expect(cdpSawText).toBe(true);

    hooks().onclose?.(peer, { code: 1000, reason: "" });
  });
});
