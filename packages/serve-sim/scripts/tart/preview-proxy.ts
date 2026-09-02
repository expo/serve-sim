import { connect as tcpConnect, createServer as createNetServer, type Server as NetServer, type Socket } from "net";
import { rewriteWebRtcSignalingJson, type IcePin } from "./ice-candidates";

export type PreviewProxy = {
  port: number;
  close(): Promise<void>;
};

const HEADER_END = Buffer.from("\r\n\r\n");

function headerValue(header: string, name: string): string | undefined {
  const match = header.match(new RegExp(`^${name}:\\s*(.*)$`, "im"));
  return match?.[1]?.trim();
}

function replaceHeader(header: string, name: string, value: string): string {
  const pattern = new RegExp(`^${name}:.*$`, "im");
  if (pattern.test(header)) return header.replace(pattern, `${name}: ${value}`);
  return header.replace("\r\n\r\n", `\r\n${name}: ${value}\r\n\r\n`);
}

function isWebRtcOfferRequest(requestLine: string): boolean {
  return /^POST\s/i.test(requestLine) && requestLine.includes("/webrtc/offer");
}

function stripHeader(header: string, name: string): string {
  return header.replace(new RegExp(`^${name}:.*\r\n`, "im"), "");
}

function headersWithLength(header: string, length: number): string {
  return replaceHeader(stripHeader(header, "Transfer-Encoding"), "Content-Length", String(length));
}

function decodeChunked(buf: Buffer): { body: Buffer; consumed: number } | undefined {
  let offset = 0;
  const parts: Buffer[] = [];
  for (;;) {
    const nl = buf.indexOf("\r\n", offset);
    if (nl < 0) return undefined;
    const size = Number.parseInt(buf.subarray(offset, nl).toString("ascii").split(";")[0].trim(), 16);
    if (!Number.isFinite(size) || size < 0) return undefined;
    const dataStart = nl + 2;
    if (size === 0) {
      const end = buf.indexOf("\r\n\r\n", nl);
      if (end < 0) return undefined;
      return { body: Buffer.concat(parts), consumed: end + 4 };
    }
    if (buf.length < dataStart + size + 2) return undefined;
    parts.push(buf.subarray(dataStart, dataStart + size));
    offset = dataStart + size + 2;
  }
}

function readHttpBody(header: string, rest: Buffer): { body: string; consumed: number } | undefined {
  const transfer = headerValue(header, "transfer-encoding")?.toLowerCase() ?? "";
  if (transfer.includes("chunked")) {
    const decoded = decodeChunked(rest);
    if (!decoded) return undefined;
    return { body: decoded.body.toString("utf8"), consumed: decoded.consumed };
  }
  const length = Number(headerValue(header, "content-length"));
  if (!Number.isFinite(length) || length < 0) return undefined;
  if (rest.length < length) return undefined;
  return { body: rest.subarray(0, length).toString("utf8"), consumed: length };
}

function isWebSocketUpgrade(header: string): boolean {
  return /^upgrade:\s*websocket/im.test(header);
}

function isSwitchingProtocols(header: string): boolean {
  return /^HTTP\/1\.[01]\s+101\b/i.test(header.split("\r\n")[0] ?? "");
}

function readMessageBody(
  header: string,
  rest: Buffer,
  emptyIfUnspecified: boolean,
): { body: string; consumed: number } | undefined {
  const read = readHttpBody(header, rest);
  if (read) return read;
  if (!emptyIfUnspecified) return undefined;
  const transfer = headerValue(header, "transfer-encoding")?.toLowerCase() ?? "";
  if (transfer.includes("chunked") || headerValue(header, "content-length") != null) return undefined;
  return { body: "", consumed: 0 };
}

function rewriteOffer(body: string, pin: IcePin): string {
  const rewritten = rewriteWebRtcSignalingJson(body, pin);
  if (process.env.SERVE_SIM_WEBRTC_DEBUG) {
    console.log("[tart-dev] pinned WebRTC ICE to tart LAN");
  }
  return rewritten;
}

function handleClient(client: Socket, upstreamPort: number, pin: IcePin): void {
  const pending: Buffer[] = [];
  let ingest: ((chunk: Buffer) => void) | undefined;

  client.on("data", (chunk: Buffer) => {
    if (ingest) ingest(chunk);
    else pending.push(chunk);
  });
  client.resume();

  const remote = tcpConnect({ port: upstreamPort, host: "127.0.0.1" }, () => {
    let reqBuf = Buffer.alloc(0);
    let resBuf = Buffer.alloc(0);
    let mode: "req" | "res" | "res-rewrite" | "splice" = "req";

    const toRemote = (buf: Buffer) => {
      if (buf.length && !remote.destroyed) remote.write(buf);
    };
    const toClient = (buf: Buffer) => {
      if (buf.length && !client.destroyed) client.write(buf);
    };

    const pumpRequests = () => {
      while (mode === "req") {
        const headerEnd = reqBuf.indexOf(HEADER_END);
        if (headerEnd < 0) return;
        const header = reqBuf.subarray(0, headerEnd + 4).toString("latin1");
        const requestLine = header.split("\r\n")[0] ?? "";
        const rest = reqBuf.subarray(headerEnd + 4);
        if (isWebSocketUpgrade(header)) {
          toRemote(reqBuf);
          reqBuf = Buffer.alloc(0);
          mode = "splice";
          return;
        }
        const offer = isWebRtcOfferRequest(requestLine);
        const body = readMessageBody(header, rest, !offer);
        if (!body) return;
        reqBuf = rest.subarray(body.consumed);
        if (offer) {
          if (process.env.SERVE_SIM_WEBRTC_DEBUG) {
            console.log("[tart-dev] webrtc offer", headerValue(header, "content-length") ?? "chunked");
          }
          const rewritten = Buffer.from(rewriteOffer(body.body, pin));
          toRemote(Buffer.concat([
            Buffer.from(headersWithLength(header, rewritten.length), "latin1"),
            rewritten,
          ]));
          mode = "res-rewrite";
          return;
        }
        toRemote(Buffer.concat([
          Buffer.from(header, "latin1"),
          rest.subarray(0, body.consumed),
        ]));
        mode = "res";
        return;
      }
    };

    const pumpResponses = () => {
      if (mode !== "res" && mode !== "res-rewrite") return;
      const headerEnd = resBuf.indexOf(HEADER_END);
      if (headerEnd < 0) return;
      const header = resBuf.subarray(0, headerEnd + 4).toString("latin1");
      if (isSwitchingProtocols(header)) {
        toClient(resBuf);
        resBuf = Buffer.alloc(0);
        mode = "splice";
        return;
      }
      const rest = resBuf.subarray(headerEnd + 4);
      const body = readMessageBody(header, rest, true);
      if (!body) return;
      if (mode === "res-rewrite") {
        const rewritten = Buffer.from(rewriteOffer(body.body, pin));
        toClient(Buffer.concat([
          Buffer.from(headersWithLength(header, rewritten.length), "latin1"),
          rewritten,
        ]));
      } else {
        toClient(Buffer.concat([
          Buffer.from(header, "latin1"),
          rest.subarray(0, body.consumed),
        ]));
      }
      resBuf = rest.subarray(body.consumed);
      mode = "req";
      pumpRequests();
    };

    ingest = (chunk: Buffer) => {
      if (mode === "splice") {
        toRemote(chunk);
        return;
      }
      reqBuf = Buffer.concat([reqBuf, chunk]);
      pumpRequests();
    };

    remote.on("data", (chunk: Buffer) => {
      if (mode === "splice") {
        toClient(chunk);
        return;
      }
      resBuf = Buffer.concat([resBuf, chunk]);
      pumpResponses();
    });

    for (const chunk of pending) ingest(chunk);
    pending.length = 0;
  });

  const closeBoth = () => {
    client.destroy();
    remote.destroy();
  };
  client.on("error", closeBoth);
  remote.on("error", closeBoth);
  client.on("close", () => {
    if (!remote.destroyed) remote.destroy();
  });
  remote.on("close", () => {
    if (!client.destroyed) client.destroy();
  });
}

function listen(server: NetServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server: NetServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startPreviewProxy(
  listenPort: number,
  upstreamPort: number,
  pin: IcePin = {},
): Promise<PreviewProxy> {
  const attach = (server: NetServer) => {
    server.on("connection", (client: Socket) => handleClient(client, upstreamPort, pin));
  };
  const v4 = createNetServer();
  attach(v4);
  await listen(v4, listenPort, "127.0.0.1");
  const addr = v4.address();
  if (!addr || typeof addr === "string") {
    await closeServer(v4);
    throw new Error("preview proxy has no port");
  }
  const port = addr.port;
  const v6 = createNetServer();
  attach(v6);
  try {
    await listen(v6, port, "::1");
  } catch {
    await closeServer(v6);
    return { port, close: () => closeServer(v4) };
  }
  return {
    port,
    close: async () => {
      await closeServer(v4);
      await closeServer(v6);
    },
  };
}
