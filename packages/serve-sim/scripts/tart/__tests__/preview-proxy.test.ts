import { connect, createServer } from "net";
import { describe, expect, test } from "bun:test";
import { startPreviewProxy } from "../preview-proxy";

const HEADER_END = Buffer.from("\r\n\r\n");

function listenRaw(
  reply: (req: { line: string; body: string }) => string,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk as Buffer]);
        const headerEnd = buf.indexOf(HEADER_END);
        if (headerEnd < 0) return;
        const header = buf.subarray(0, headerEnd).toString("latin1");
        const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
        if (buf.length < headerEnd + 4 + length) return;
        const body = buf.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
        const payload = Buffer.from(reply({ line: header.split("\r\n")[0] ?? "", body }));
        sock.end(Buffer.concat([
          Buffer.from(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`,
          ),
          payload,
        ]));
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({
        port: addr.port,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => (error ? closeReject(error) : closeResolve()));
        }),
      });
    });
  });
}

function rawHttpJson(
  host: string,
  port: number,
  path: string,
  opts?: { method?: string; body?: string },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const method = opts?.method ?? "GET";
    const body = opts?.body ?? "";
    const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}`, "Connection: close"];
    if (body) {
      lines.push("Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`);
    }
    const sock = connect({ port, host: host === "[::1]" ? "::1" : host });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`http timeout ${path} (${buf.length} bytes)`));
    }, 2000);
    sock.on("connect", () => sock.write(`${lines.join("\r\n")}\r\n\r\n${body}`));
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk as Buffer]);
    });
    sock.on("end", () => {
      clearTimeout(timer);
      const split = buf.indexOf(HEADER_END);
      const text = split < 0 ? buf.toString("utf8") : buf.subarray(split + 4).toString("utf8");
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    sock.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("tart-dev preview proxy", () => {
  test("rewrites offer and answer SDP on /webrtc/offer", async () => {
    const sdp = [
      "a=candidate:1 1 udp 1 127.0.0.1 9 typ host",
      "a=candidate:2 1 udp 1 192.168.64.1 9 typ host",
      "a=candidate:3 1 udp 1 fd2a::1 9 typ host",
    ].join("\r\n");
    let seenOffer = "";
    const upstream = await listenRaw((req) => {
      seenOffer = req.body;
      return JSON.stringify({ type: "answer", sdp });
    });
    const proxy = await startPreviewProxy(0, upstream.port);
    try {
      const answer = await rawHttpJson("127.0.0.1", proxy.port, "/helper/x/webrtc/offer", {
        method: "POST",
        body: JSON.stringify({ type: "offer", sdp }),
      }) as { sdp: string };
      const posted = JSON.parse(seenOffer) as { sdp: string; iceServers?: unknown };
      expect(posted.iceServers).toEqual([]);
      expect(posted.sdp).not.toContain("127.0.0.1");
      expect(posted.sdp).not.toContain("192.168.64.1");
      expect(posted.sdp).toContain("fd2a::1");
      expect(answer.sdp).not.toContain("127.0.0.1");
      expect(answer.sdp).not.toContain("192.168.64.1");
      expect(answer.sdp).toContain("fd2a::1");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("rewrites a chunked /webrtc/offer POST", async () => {
    const sdp = [
      "a=candidate:1 1 udp 2122260223 1a2b3c4d-1.local 9 typ host",
      "a=candidate:2 1 udp 2122185727 5e6f7a8b-2.local 9 typ host",
      "a=candidate:3 1 udp 1 fd2a:8aff:c3fa:95c6::1 9 typ host",
    ].join("\r\n");
    let seenOffer = "";
    const upstream = await listenRaw((req) => {
      seenOffer = req.body;
      return JSON.stringify({ type: "answer", sdp });
    });
    const proxy = await startPreviewProxy(0, upstream.port);
    try {
      const body = JSON.stringify({
        type: "offer",
        sdp,
        iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
      });
      const answer = await new Promise<unknown>((resolve, reject) => {
        const sock = connect({ port: proxy.port, host: "127.0.0.1" });
        let buf = Buffer.alloc(0);
        const timer = setTimeout(() => reject(new Error("chunked offer timeout")), 2000);
        sock.on("connect", () => {
          sock.write("POST /helper/x/webrtc/offer HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
          sock.write(`${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`);
        });
        sock.on("data", (chunk) => {
          buf = Buffer.concat([buf, chunk as Buffer]);
        });
        sock.on("end", () => {
          clearTimeout(timer);
          const split = buf.indexOf(HEADER_END);
          const text = split < 0 ? buf.toString("utf8") : buf.subarray(split + 4).toString("utf8");
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(error);
          }
        });
        sock.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      }) as { sdp: string };
      const posted = JSON.parse(seenOffer) as { sdp: string; iceServers?: unknown };
      expect(posted.iceServers).toEqual([]);
      expect(posted.sdp).not.toContain("1a2b3c4d-1.local");
      expect(posted.sdp).toContain("fd2a:8aff:c3fa:95c6::1");
      expect(answer.sdp).not.toContain("192.168.64.1");
      expect(answer.sdp).toContain("fd2a:8aff:c3fa:95c6::1");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("rewrites offer after a keep-alive GET on the same socket", async () => {
    const sdp = [
      "a=candidate:1 1 udp 1 127.0.0.1 9 typ host",
      "a=candidate:2 1 udp 1 192.168.64.1 9 typ host",
      "a=candidate:3 1 udp 1 fd2a::1 9 typ host",
    ].join("\r\n");
    let seenOffer = "";
    const upstream = await new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
      const server = createServer((sock) => {
        let buf = Buffer.alloc(0);
        sock.on("data", (chunk) => {
          buf = Buffer.concat([buf, chunk as Buffer]);
          for (;;) {
            const headerEnd = buf.indexOf(HEADER_END);
            if (headerEnd < 0) return;
            const header = buf.subarray(0, headerEnd).toString("latin1");
            const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
            if (buf.length < headerEnd + 4 + length) return;
            const line = header.split("\r\n")[0] ?? "";
            const body = buf.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
            buf = buf.subarray(headerEnd + 4 + length);
            const payload = Buffer.from(
              line.includes("/webrtc/offer")
                ? (seenOffer = body, JSON.stringify({ type: "answer", sdp }))
                : JSON.stringify({ status: "ok" }),
            );
            sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${payload.length}\r\nConnection: keep-alive\r\n\r\n`);
            sock.write(payload);
          }
        });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("no port"));
          return;
        }
        resolve({
          port: addr.port,
          close: () => new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
        });
      });
    });
    const proxy = await startPreviewProxy(0, upstream.port);
    try {
      const sock = connect({ port: proxy.port, host: "127.0.0.1" });
      const readJson = (): Promise<unknown> => new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          const headerEnd = buf.indexOf(HEADER_END);
          if (headerEnd < 0) return;
          const header = buf.subarray(0, headerEnd).toString("latin1");
          const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
          if (buf.length < headerEnd + 4 + length) return;
          sock.off("data", onData);
          resolve(JSON.parse(buf.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8")));
        };
        sock.on("data", onData);
        sock.on("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        sock.on("connect", () => resolve());
        sock.on("error", reject);
      });
      sock.write("GET /helper/x/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
      expect(await readJson()).toEqual({ status: "ok" });
      const offer = JSON.stringify({ type: "offer", sdp });
      sock.write(
        `POST /helper/x/webrtc/offer HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${Buffer.byteLength(offer)}\r\nConnection: close\r\n\r\n${offer}`,
      );
      const answer = await readJson() as { sdp: string };
      const posted = JSON.parse(seenOffer) as { sdp: string; iceServers?: unknown };
      expect(posted.iceServers).toEqual([]);
      expect(posted.sdp).not.toContain("192.168.64.1");
      expect(posted.sdp).toContain("fd2a::1");
      expect(answer.sdp).toContain("fd2a::1");
      sock.destroy();
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("does not rewrite other paths", async () => {
    const upstream = await listenRaw(() => JSON.stringify({ status: "ok" }));
    const proxy = await startPreviewProxy(0, upstream.port);
    try {
      expect(await rawHttpJson("127.0.0.1", proxy.port, "/helper/x/health")).toEqual({ status: "ok" });
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("accepts http://localhost via IPv6 loopback", async () => {
    const upstream = await listenRaw(() => JSON.stringify({ status: "ok" }));
    const proxy = await startPreviewProxy(0, upstream.port);
    try {
      expect(await rawHttpJson("[::1]", proxy.port, "/helper/x/health")).toEqual({ status: "ok" });
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("proxies websocket frames used for HID", async () => {
    const { WebSocket: NodeWebSocket, WebSocketServer } = await import("ws");
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const upstreamPort = (wss.address() as { port: number }).port;
    wss.on("connection", (socket) => {
      socket.on("message", (data) => socket.send(data));
    });
    const proxy = await startPreviewProxy(0, upstreamPort);
    try {
      const ws = new NodeWebSocket(`ws://127.0.0.1:${proxy.port}/helper/x/ws`);
      const payload = Buffer.from([0x03, 1, 2, 3]);
      const got = await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("websocket timeout")), 2000);
        ws.on("open", () => ws.send(payload));
        ws.on("message", (data) => {
          clearTimeout(timer);
          resolve(Buffer.from(data as Buffer));
        });
        ws.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      expect(got).toEqual(payload);
      ws.close();
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  test("proxies the exec-ws control socket handshake", async () => {
    const { WebSocket: NodeWebSocket, WebSocketServer } = await import("ws");
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(String(data));
        if (msg.token === "t") socket.send(JSON.stringify({ ready: true }));
      });
    });
    const proxy = await startPreviewProxy(0, (wss.address() as { port: number }).port);
    try {
      const ws = new NodeWebSocket(`ws://127.0.0.1:${proxy.port}/exec-ws`);
      const ready = await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("control socket connect timeout")), 2000);
        ws.on("open", () => ws.send(JSON.stringify({ token: "t" })));
        ws.on("message", (data) => {
          clearTimeout(timer);
          resolve(JSON.parse(String(data)).ready === true);
        });
        ws.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      expect(ready).toBe(true);
      ws.close();
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
