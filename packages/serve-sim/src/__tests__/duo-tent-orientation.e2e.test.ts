import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import WebSocket from "ws";
import { stateFileForDevice, type ServeSimDeviceState } from "../state";
import type { HingePose } from "../hinge-control";

// Opt in against a rebuilt running server and a booted Duo with a landscape-
// capable app (Safari or fixtures/duo). This changes the device's physical pose.
const device = process.env.SERVE_SIM_DUO_E2E_DEVICE;

async function selectPose(state: ServeSimDeviceState, value: HingePose) {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(state.wsUrl, {
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : undefined,
    });
    const timeout = setTimeout(() => finish(new Error("Pose acknowledgement timed out")), 5000);
    let settled = false;
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error); else resolve();
    }
    socket.on("error", finish);
    socket.on("close", () => finish(new Error("Pose connection closed before acknowledgement")));
    socket.on("open", () => socket.send(Buffer.concat([
      Buffer.from([0x10]), Buffer.from(JSON.stringify({ requestId: 1, command: { control: "pose", value } })),
    ])));
    socket.on("message", (data) => {
      const frame = Buffer.from(data as Buffer);
      if (frame[0] !== 0x90) return;
      const reply = JSON.parse(frame.subarray(1).toString());
      finish(reply.ok ? undefined : new Error(reply.error ?? "Pose failed"));
    });
  });
}

test.skipIf(!device)("Tent makes the cover landscape regardless of the previous preset", async () => {
  const state = JSON.parse(readFileSync(stateFileForDevice(device!), "utf8")) as ServeSimDeviceState;
  const configUrl = state.streamUrl.replace(/\/stream\.[^/]+$/, "/config");
  for (const previous of ["closed", "open", "book", "laptop", "tent"] as const) {
    await selectPose(state, previous);
    await selectPose(state, "tent");
    const deadline = Date.now() + 5000;
    let config;
    do {
      const response = await fetch(configUrl, {
        headers: state.token ? { Authorization: `Bearer ${state.token}` } : undefined,
        signal: AbortSignal.timeout(5000),
      });
      expect(response.ok).toBe(true);
      config = await response.json();
      if (config.screenId === 1 && config.orientation === "landscape_left") break;
      await Bun.sleep(100);
    } while (Date.now() < deadline);
    expect({ previous, ...config }).toMatchObject({
      previous, screenId: 1, orientation: "landscape_left", hingeAngle: 80, hingePose: "tent", tableMode: true,
    });
  }
}, 60_000);
