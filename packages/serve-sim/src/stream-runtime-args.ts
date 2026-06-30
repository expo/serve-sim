import type { ServeSimDeviceState } from "./state";

type StreamRuntimeOptions = Pick<
  ServeSimDeviceState,
  "transport" | "codec" | "webrtcCodec" | "webrtcIceServers"
>;

function urlsWithPrefix(
  servers: StreamRuntimeOptions["webrtcIceServers"],
  prefixes: string[],
): string[] {
  const urls: string[] = [];
  for (const server of servers ?? []) {
    for (const url of server.urls) {
      const lower = url.toLowerCase();
      if (prefixes.some((prefix) => lower.startsWith(prefix))) urls.push(url);
    }
  }
  return urls;
}

function firstTurnServer(
  servers: StreamRuntimeOptions["webrtcIceServers"],
): NonNullable<StreamRuntimeOptions["webrtcIceServers"]>[number] | null {
  for (const server of servers ?? []) {
    if (server.urls.some((url) => /^turns?:/i.test(url))) return server;
  }
  return null;
}

export function streamRuntimeArgs(stream?: StreamRuntimeOptions): string[] {
  if (!stream) return [];

  const args: string[] = [];
  if (stream.transport) args.push("--transport", stream.transport);
  if (stream.codec) args.push("--codec", stream.codec);
  if (stream.webrtcCodec) args.push("--webrtc-codec", stream.webrtcCodec);

  const stunUrls = urlsWithPrefix(stream.webrtcIceServers, ["stun:", "stuns:"]);
  if (stunUrls.length) args.push("--stun-url", stunUrls.join(","));

  const turnUrls = urlsWithPrefix(stream.webrtcIceServers, ["turn:", "turns:"]);
  if (turnUrls.length) {
    args.push("--turn-url", turnUrls.join(","));
    const turnServer = firstTurnServer(stream.webrtcIceServers);
    if (turnServer?.username) args.push("--turn-username", turnServer.username);
    if (turnServer?.credential) args.push("--turn-credential", turnServer.credential);
  }

  return args;
}
