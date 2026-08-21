/**
 * Run serve-sim the way EAS Simulator runs it: WebRTC over Cloudflare TURN, reachable from outside
 * your network through a cloudflared tunnel.
 *
 * Needs a Cloudflare Realtime TURN key of your own (dashboard → Realtime → TURN):
 *   CLOUDFLARE_TURN_KEY_ID=…  CLOUDFLARE_TURN_API_TOKEN=…  bun run scripts/serve-turn.ts
 *
 * Do not reuse the production key. Its credentials are minted per session and short-lived.
 *
 * The tunnel URL this prints is public and unauthenticated: anyone with it reaches a server whose
 * /exec route runs shell commands. Keep the run short. Once serve-sim#49 lands, add --require-token.
 */
import { spawn } from "node:child_process";

const TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";
const TTL_SECONDS = 3 * 60 * 60;

/** Matches the flags eas-cli passes, so a local repro degrades the same way production does. */
const STREAM_ARGS = [
  "--transport", "webrtc",
  "--webrtc-codec", "vp8",
  "--max-dimension", "1280",
  "--video-fps", "60",
  "--video-bitrate", "3000000",
];

interface IceServer {
  urls: string[] | string;
  username?: string;
  credential?: string;
}

async function mintIceServers(keyId: string, apiToken: string): Promise<IceServer[]> {
  const response = await fetch(`${TURN_API}/${keyId}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl: TTL_SECONDS }),
  });
  if (!response.ok) {
    throw new Error(
      `Cloudflare refused to mint TURN credentials (HTTP ${response.status}). Check that the key id ` +
        `and token belong to the same Realtime TURN key.\n${await response.text()}`,
    );
  }
  const body = (await response.json()) as { iceServers?: IceServer | IceServer[] };
  const servers = body.iceServers;
  if (!servers) throw new Error("Cloudflare returned no ICE servers.");
  return Array.isArray(servers) ? servers : [servers];
}

/** Split the minted servers the way serve-sim's flags expect: STUN urls, then one TURN entry. */
export function iceServersToArgs(iceServers: IceServer[]): string[] {
  const urlsOf = (server: IceServer) => (Array.isArray(server.urls) ? server.urls : [server.urls]);
  const stun = iceServers.filter((s) => !s.username).flatMap(urlsOf);
  const turn = iceServers.find((s) => s.username && s.credential);
  const args: string[] = [];
  if (stun.length > 0) args.push("--stun-url", stun.join(","));
  if (turn?.username && turn.credential) {
    args.push(
      "--turn-url", urlsOf(turn).join(","),
      "--turn-username", turn.username,
      "--turn-credential", turn.credential,
    );
  }
  return args;
}

async function main(): Promise<void> {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (!keyId || !apiToken) {
    console.error(
      "Set CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN. Create a Realtime TURN key in the\n" +
        "Cloudflare dashboard (Realtime → TURN); the key id and token are shown when you create it.",
    );
    process.exit(1);
  }

  const port = process.env.PORT ?? "3200";
  const turnArgs = iceServersToArgs(await mintIceServers(keyId, apiToken));
  if (!turnArgs.includes("--turn-url")) {
    console.error("Cloudflare returned STUN but no TURN entry, so a relayed path cannot be tested.");
    process.exit(1);
  }

  // Loopback bind plus a tunnel, same as production.
  const serveSim = spawn(
    "bun",
    ["run", "src/index.ts", "serve", "--port", port, "--host", "127.0.0.1", ...STREAM_ARGS, ...turnArgs],
    { stdio: "inherit", cwd: new URL("..", import.meta.url).pathname },
  );

  const tunnel = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
    stdio: "inherit",
  });
  tunnel.on("error", () => {
    console.error("cloudflared not found. Install it with `brew install cloudflared`.");
  });

  const stop = () => {
    serveSim.kill("SIGTERM");
    tunnel.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  serveSim.on("exit", (code) => {
    tunnel.kill("SIGTERM");
    process.exit(code ?? 0);
  });
}

if (import.meta.main) {
  await main();
}
