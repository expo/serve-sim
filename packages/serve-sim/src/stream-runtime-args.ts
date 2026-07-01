import type { StreamSettings, WebRtcIceServer } from "./state";

function urlsWithPrefix(
  servers: WebRtcIceServer[] | undefined,
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
  servers: WebRtcIceServer[] | undefined,
): WebRtcIceServer | null {
  for (const server of servers ?? []) {
    if (server.urls.some((url) => /^turns?:/i.test(url))) return server;
  }
  return null;
}

export function streamRuntimeArgs(settings?: StreamSettings): string[] {
  if (!settings) return [];

  const args: string[] = [];
  args.push("--transport", settings.transport);
  if (settings.transport === "http") {
    if (settings.codec) args.push("--codec", settings.codec);
    return args;
  }

  args.push("--webrtc-codec", settings.codec);

  const stunUrls = urlsWithPrefix(settings.iceServers, ["stun:", "stuns:"]);
  if (stunUrls.length) args.push("--stun-url", stunUrls.join(","));

  const turnUrls = urlsWithPrefix(settings.iceServers, ["turn:", "turns:"]);
  if (turnUrls.length) {
    args.push("--turn-url", turnUrls.join(","));
    const turnServer = firstTurnServer(settings.iceServers);
    if (turnServer?.username) args.push("--turn-username", turnServer.username);
    if (turnServer?.credential) args.push("--turn-credential", turnServer.credential);
  }

  return args;
}
