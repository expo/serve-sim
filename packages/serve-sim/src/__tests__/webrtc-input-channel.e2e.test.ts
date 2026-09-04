import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { execSync } from "child_process";
import { existsSync } from "fs";
import net from "net";
import { join } from "path";
import { RTCPeerConnection, RTCRtpCodecParameters, type RTCDataChannel } from "werift";

// End-to-end proof that HID input rides the WebRTC "input" data channel: a real
// receiving peer opens the channel, sends the same binary [tag][JSON] frames the
// /ws socket carries, and the tap surfaces in the server's event log — which
// only happens after the frame crossed libwebrtc -> CaptureEngine -> the N-API
// bridge -> DeviceSession.handleHidMessage. Also pins the label filter: a
// channel the server does not recognize is closed, not silently absorbed.

const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");
const WS_TAG_TOUCH = 0x03;

function bootedUdid(): string | null {
  try {
    const out = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
    const data = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const [runtime, devices] of Object.entries(data.devices)) {
      if (!/iOS/i.test(runtime)) continue;
      for (const d of devices) if (d.state === "Booted") return d.udid;
    }
  } catch {}
  return null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate a port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function hidFrame(tag: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf-8");
  return Buffer.concat([Buffer.from([tag]), json]);
}

function waitForChannelState(
  channel: RTCDataChannel,
  state: "open" | "closed",
  budgetMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (channel.readyState === state) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), budgetMs);
    const { unSubscribe } = channel.stateChanged.subscribe((next) => {
      if (next !== state) return;
      clearTimeout(timer);
      unSubscribe();
      resolve(true);
    });
  });
}

async function negotiate(offerUrl: string): Promise<{
  pc: RTCPeerConnection;
  inputChannel: RTCDataChannel;
}> {
  const pc = new RTCPeerConnection({
    codecs: {
      video: [new RTCRtpCodecParameters({ mimeType: "video/VP8", clockRate: 90000, payloadType: 96 })],
    },
  });
  // Mirrors the browser client: the channel is created before the offer so the
  // SCTP transport is negotiated together with the video.
  const inputChannel = pc.createDataChannel("input");
  pc.addTransceiver("video", { direction: "recvonly" });
  await pc.setLocalDescription(await pc.createOffer());
  const response = await fetch(offerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "offer",
      sdp: pc.localDescription!.sdp,
      sessionId: crypto.randomUUID(),
      codec: "vp8",
    }),
  });
  if (!response.ok) {
    throw new Error(`offer rejected: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  const answer = (await response.json()) as { sdp: string };
  await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
  return { pc, inputChannel };
}

type EventLogEntry = { id: number; kind: string; source: string };

const udid = bootedUdid();
const describeIfSim = udid && existsSync(CLI) ? describe : describe.skip;

describeIfSim("WebRTC input data channel", () => {
  let server: ChildProcess | null = null;
  let baseUrl = "";
  let offerUrl = "";
  let serverOutput = "";

  async function readEvents(): Promise<EventLogEntry[]> {
    const response = await fetch(`${baseUrl}/api/event-log?device=${udid}`);
    if (!response.ok) throw new Error(`event log unavailable: ${response.status}`);
    const body = (await response.json()) as { events: EventLogEntry[] };
    return body.events;
  }

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    offerUrl = `${baseUrl}/helper/${udid}/webrtc/offer`;
    server = spawn(
      "node",
      [
        CLI,
        "--no-preview",
        "--port", String(port),
        "--transport", "webrtc",
        "--webrtc-codec", "vp8",
        "--max-dimension", "1280",
        udid!,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SERVE_SIM_WEBRTC_DEBUG: "1" } },
    );
    server.stdout?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });
    server.stderr?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });

    const ready = await waitFor(async () => {
      try {
        return (await fetch(`${baseUrl}/healthz`)).ok;
      } catch {
        return false;
      }
    }, 60_000);
    if (!ready) {
      throw new Error(`serve-sim never became ready\noutput:\n${serverOutput.slice(0, 800)}`);
    }
  }, 70_000);

  afterAll(() => {
    server?.kill("SIGTERM");
  });

  test("a tap sent over the input channel reaches the HID dispatch", async () => {
    const { pc, inputChannel } = await negotiate(offerUrl);
    try {
      const opened = await waitForChannelState(inputChannel, "open", 20_000);
      if (!opened) {
        throw new Error(`input channel never opened\nserver output:\n${serverOutput.slice(-1_500)}`);
      }

      const baseline = (await readEvents()).reduce((max, event) => Math.max(max, event.id), 0);

      // begin + end at one point registers as a tap in the event log — proof the
      // frame took the same dispatch path as /ws input.
      inputChannel.send(hidFrame(WS_TAG_TOUCH, { type: "begin", x: 0.5, y: 0.5 }));
      inputChannel.send(hidFrame(WS_TAG_TOUCH, { type: "end", x: 0.5, y: 0.5 }));

      const tapLogged = await waitFor(async () => {
        const events = await readEvents();
        return events.some((event) => event.id > baseline && event.source === "hid" && event.kind === "tap");
      }, 15_000);
      expect(tapLogged).toBe(true);
    } finally {
      pc.close();
    }
  }, 60_000);

  test("a channel with an unknown label is closed by the server", async () => {
    const { pc, inputChannel } = await negotiate(offerUrl);
    try {
      expect(await waitForChannelState(inputChannel, "open", 20_000)).toBe(true);

      const bogus = pc.createDataChannel("bogus");
      expect(await waitForChannelState(bogus, "closed", 15_000)).toBe(true);
      expect(inputChannel.readyState).toBe("open");
    } finally {
      pc.close();
    }
  }, 60_000);
});
