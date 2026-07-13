import { WebSocket } from "ws";
import type { HidSocket } from "./device-session";
import type { ExecWebSocket } from "./exec-ws-utils";

/**
 * Incoming WebSocket message passed to the `onmessage` hook. Declared with
 * the subset of the host's lazy conversion helpers the middleware uses.
 */
export type UpgradeSocketMessage = {
  readonly isBinary: boolean;
  text(): string;
  uint8Array(): Uint8Array;
};

/** Connected WebSocket peer passed to the lifecycle hooks. */
export type UpgradeSocketPeer = {
  send(data: string | Uint8Array | ArrayBufferLike | object): void;
  close(code?: number, reason?: string): void;
};

/** Lifecycle hooks passed to `context.upgrade()`, wired once the handshake commits. */
export type UpgradeSocketHooks = {
  onopen?(peer: UpgradeSocketPeer): void;
  onmessage?(peer: UpgradeSocketPeer, message: UpgradeSocketMessage): void;
  onclose?(peer: UpgradeSocketPeer, details: { code: number; reason: string }): void;
  onerror?(peer: UpgradeSocketPeer, error: Error): void;
};

/**
 * Per-request context passed by the host as the second middleware argument.
 * `upgrade()` returns a marker Response; the handshake commits only when the
 * middleware returns that response to the host. It throws for plain HTTP
 * requests, so callers must gate on `isWebSocketUpgradeRequest` first.
 */
export type UpgradeRequestContext = {
  upgrade(hooks: UpgradeSocketHooks): Response;
};

export function isWebSocketUpgradeRequest(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/**
 * Adapt a hook-based upgrade into the `ExecWebSocket` shape consumed by
 * `createExecWebSocketHandler`. The adapter socket exists before the
 * handshake commits so the exec handler can wire its listeners synchronously;
 * `readyState` stays CONNECTING until the `onopen` hook delivers the peer,
 * and a `close()` issued before then (e.g. the handler's origin check) closes
 * the peer as soon as it appears.
 */
export function execSocketFromUpgrade(context: UpgradeRequestContext): {
  socket: ExecWebSocket;
  response: Response;
} {
  const messageListeners: Array<(data: unknown) => void> = [];
  const closeListeners: Array<() => void> = [];
  const errorListeners: Array<(error?: unknown) => void> = [];
  let peer: UpgradeSocketPeer | null = null;
  let closed = false;

  const socket: ExecWebSocket = {
    OPEN: 1,
    get readyState() {
      return peer !== null && !closed ? 1 : 0;
    },
    send(data: string) {
      if (!closed) peer?.send(data);
    },
    close() {
      if (closed) return;
      closed = true;
      peer?.close();
    },
    on(event: "message" | "error" | "close", listener: (data?: unknown) => void) {
      if (event === "message") messageListeners.push(listener);
      else if (event === "close") closeListeners.push(listener as () => void);
      else errorListeners.push(listener);
    },
  };

  const response = context.upgrade({
    onopen(p) {
      if (closed) {
        p.close();
        return;
      }
      peer = p;
    },
    onmessage(_p, message) {
      for (const cb of messageListeners) cb(message.text());
    },
    onclose() {
      if (closed) return;
      closed = true;
      for (const cb of closeListeners) cb();
    },
    onerror(_p, error) {
      for (const cb of errorListeners) cb(error);
    },
  });
  return { socket, response };
}

/**
 * Adapt a hook-based upgrade into the `HidSocket` a DeviceSession consumes.
 * `attach` runs from the `onopen` hook, once the peer can accept the config
 * frame `attachHidSocket` seeds immediately.
 */
export function hidSocketFromUpgrade(
  context: UpgradeRequestContext,
  attach: (socket: HidSocket) => void,
): Response {
  const messageListeners: Array<(data: Buffer) => void> = [];
  const closeListeners: Array<() => void> = [];
  let peer: UpgradeSocketPeer | null = null;
  let closed = false;

  const fireClose = () => {
    if (closed) return;
    closed = true;
    for (const cb of closeListeners) cb();
  };

  const socket: HidSocket = {
    send(data: Buffer) {
      if (!closed) peer?.send(data);
    },
    on(event: "message" | "close" | "error", cb: (data: Buffer) => void) {
      if (event === "message") messageListeners.push(cb);
      else closeListeners.push(cb as unknown as () => void);
    },
    close() {
      fireClose();
      peer?.close();
    },
  };

  return context.upgrade({
    onopen(p) {
      if (closed) {
        p.close();
        return;
      }
      peer = p;
      attach(socket);
    },
    onmessage(_p, message) {
      const bytes = message.uint8Array();
      const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (const cb of messageListeners) cb(data);
    },
    onclose: fireClose,
    onerror: fireClose,
  });
}

/**
 * Bridge a hook-based upgrade to an upstream WebSocket (the same-origin
 * DevTools proxy). The upstream URL resolves lazily because starting the
 * inspect-webkit bridge is async; browser frames arriving before the upstream
 * opens are queued, matching `bridgeWebSocketFrames`'s raw-socket behavior.
 */
export function bridgeUpgradeToWebSocket(
  context: UpgradeRequestContext,
  resolveUpstreamUrl: () => Promise<string>,
): Response {
  let upstream: WebSocket | null = null;
  let upstreamOpen = false;
  let closed = false;
  let pending: Array<string | Uint8Array> = [];

  const closeUpstream = () => {
    closed = true;
    pending = [];
    try { upstream?.close(); } catch {}
  };

  return context.upgrade({
    onopen(peer) {
      void (async () => {
        let url: string;
        try {
          url = await resolveUpstreamUrl();
        } catch {
          closed = true;
          peer.close(1011, "upstream unavailable");
          return;
        }
        if (closed) return;
        const socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        upstream = socket;
        const closeBoth = () => {
          if (closed) return;
          closeUpstream();
          try { peer.close(); } catch {}
        };
        socket.onopen = () => {
          upstreamOpen = true;
          for (const frame of pending) socket.send(frame);
          pending = [];
        };
        socket.onmessage = (event) => {
          const data = event.data;
          peer.send(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
        };
        socket.onerror = closeBoth;
        socket.onclose = closeBoth;
      })();
    },
    onmessage(_peer, message) {
      if (closed) return;
      // Preserve the frame type across the relay: forwarding a text frame's
      // bytes as a Uint8Array would flip it to a binary frame.
      const frame = message.isBinary ? message.uint8Array() : message.text();
      if (upstream && upstreamOpen) {
        upstream.send(frame);
      } else {
        pending.push(frame);
      }
    },
    onclose: closeUpstream,
    onerror: closeUpstream,
  });
}
