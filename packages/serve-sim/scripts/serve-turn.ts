/**
 * Run serve-sim over Cloudflare TURN behind a cloudflared tunnel, the way EAS Simulator reaches it.
 *
 * Needs your own Realtime TURN key (Cloudflare dashboard → Realtime → TURN), not the production one:
 *   CLOUDFLARE_TURN_KEY_ID=… CLOUDFLARE_TURN_API_TOKEN=… bun run serve:turn
 *
 * The tunnel URL it prints is public, and the exec token is handed to any page load, so anyone with
 * the URL can run shell commands on this machine. Keep the run short and use a key you can rotate.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { streamRuntimeArgs } from "../src/stream-runtime-args";
import type { WebRtcIceServer } from "../src/stream-settings";

type CloudflareIceServer = Omit<WebRtcIceServer, "urls"> & { urls: string[] | string };

const TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";
/** Short, because the credentials reach anyone who loads the tunnel URL. */
const TTL_SECONDS = 10 * 60;

/** Matches the flags eas-cli passes, so a local repro degrades the same way production does. */
const STREAM_SETTINGS = {
  transport: "webrtc",
  codec: "vp8",
  maxDimension: 1280,
  mjpegQuality: 0.55,
  h264Bitrate: 3_000_000,
  h264Fps: 60,
} as const;

async function findFreePort(): Promise<number> {
  const server = createServer();
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  if (address === null || typeof address === "string") throw new Error("Could not allocate a port.");
  return address.port;
}

async function mintIceServers(keyId: string, apiToken: string): Promise<WebRtcIceServer[]> {
  const response = await fetch(
    `${TURN_API}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    },
  );
  if (!response.ok) {
    const hint = response.status === 404
      ? " The id and token must come from the same Realtime TURN key, and a key deleted or rotated" +
        " in the dashboard reads as missing here."
      : "";
    throw new Error(`Cloudflare refused to mint TURN credentials (HTTP ${response.status}).${hint}`);
  }
  const body = (await response.json()) as { iceServers?: CloudflareIceServer | CloudflareIceServer[] };
  const servers = body.iceServers;
  if (!servers) throw new Error("Cloudflare returned no ICE servers.");
  // Cloudflare may answer with one object and with `urls` as a bare string. Iterating a string
  // yields characters, so normalising here is what keeps the URLs from silently vanishing.
  return (Array.isArray(servers) ? servers : [servers]).map((server) => ({
    ...server,
    urls: Array.isArray(server.urls) ? server.urls : [server.urls],
  }));
}

async function main(): Promise<void> {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN?.trim();
  if (!keyId || !apiToken) {
    console.error(
      "Set CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN. Create a Realtime TURN key in the\n" +
        "Cloudflare dashboard (Realtime → TURN); the key id and token are shown when you create it.",
    );
    process.exit(1);
  }

  const iceServers = await mintIceServers(keyId, apiToken);
  const streamArgs = streamRuntimeArgs({ ...STREAM_SETTINGS, iceServers });
  if (!streamArgs.includes("--turn-credential")) {
    console.error("Cloudflare returned no usable TURN entry, so a relayed path cannot be tested.");
    process.exit(1);
  }

  const port = Number(process.env.PORT) || (await findFreePort());
  const debugLog = join(mkdtempSync(join(tmpdir(), "serve-sim-stream-")), "stream-debug.ndjson");

  // The minted relay credentials are all the children need; the API token stays in this process.
  const childEnv = { ...process.env };
  delete childEnv.CLOUDFLARE_TURN_KEY_ID;
  delete childEnv.CLOUDFLARE_TURN_API_TOKEN;

  // dist, not src: the preview HTML is stamped in at build time, so an unbuilt run serves no page.
  const serveSim = spawn(
    "node",
    ["dist/serve-sim.js", "--port", String(port), "--host", "127.0.0.1",
      "--debug-stream", debugLog, ...streamArgs],
    { stdio: "inherit", cwd: fileURLToPath(new URL("..", import.meta.url)), env: childEnv },
  );
  const tunnel = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
    stdio: "inherit",
    env: childEnv,
  });

  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    serveSim.kill("SIGTERM");
    tunnel.kill("SIGTERM");
    process.exit(code);
  };

  serveSim.on("error", (error) => {
    console.error(`Could not start serve-sim: ${error.message}`);
    stop(1);
  });
  // Without the tunnel there is no relayed path, which is the only reason to run this.
  tunnel.on("error", () => {
    console.error("cloudflared not found. Install it with `brew install cloudflared`.");
    stop(1);
  });
  tunnel.on("exit", () => {
    console.error("cloudflared exited, so the printed URL is dead.");
    stop(1);
  });
  serveSim.on("exit", (code, signal) => stop(signal ? 1 : code ?? 0));
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
}

if (import.meta.main) {
  await main();
}
