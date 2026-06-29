import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "fs";
import { createServer } from "net";
import { dirname } from "path";
import {
  cameraHelperBundlesFile,
  cameraHelperPidFile,
  cameraHelperSocketFile,
  isCameraHelperAlive,
  readCameraStatus,
} from "../camera-status";
import { simMiddleware } from "../middleware";

const udid = randomUUID().toUpperCase();
const stateFiles = [
  cameraHelperPidFile(udid),
  cameraHelperBundlesFile(udid),
  cameraHelperSocketFile(udid),
];

afterAll(() => {
  for (const path of stateFiles) {
    try { unlinkSync(path); } catch {}
  }
});

describe("camera status", () => {
  test("treats a malformed pid file as a stopped helper", async () => {
    mkdirSync(dirname(cameraHelperPidFile(udid)), { recursive: true });
    writeFileSync(cameraHelperPidFile(udid), "not-a-pid");

    expect(isCameraHelperAlive(udid)).toBe(false);
    expect(await readCameraStatus(udid)).toEqual({ udid, alive: false });
  });

  test("serves status without creating a simulator session and rejects writes", async () => {
    const middleware = simMiddleware({ basePath: "/.sim", proxyHelpers: true });
    const url = `http://localhost/.sim/helper/${udid}/camera/status`;

    const response = await middleware(new Request(url));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ udid, alive: false });

    const writeResponse = await middleware(new Request(url, { method: "POST" }));
    expect(writeResponse?.status).toBe(405);
    expect(writeResponse?.headers.get("allow")).toBe("GET");
    expect(await writeResponse?.json()).toEqual({ error: "method_not_allowed" });
  });

  test("decodes split UTF-8 replies and keeps status-owned fields authoritative", async () => {
    const socketPath = cameraHelperSocketFile(udid);
    try { unlinkSync(socketPath); } catch {}
    const reply = Buffer.from(JSON.stringify({
      ok: true,
      source: "video",
      arg: "/tmp/zażółć.mov",
      alive: false,
      udid: "wrong-device",
      helperPid: 0,
      bundleIds: ["wrong.bundle"],
    }) + "\n");
    const split = reply.indexOf(Buffer.from("ż")) + 1;
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write(reply.subarray(0, split));
        socket.end(reply.subarray(split));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    writeFileSync(cameraHelperPidFile(udid), String(process.pid));
    writeFileSync(cameraHelperBundlesFile(udid), JSON.stringify({
      helperPid: process.pid,
      bundleIds: ["com.example.app", 42],
    }));

    try {
      expect(await readCameraStatus(udid)).toEqual({
        udid,
        alive: true,
        helperPid: process.pid,
        bundleIds: ["com.example.app"],
        ok: true,
        source: "video",
        arg: "/tmp/zażółć.mov",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
