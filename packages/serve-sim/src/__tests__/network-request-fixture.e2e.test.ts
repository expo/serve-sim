import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { createServer, type Server } from "http";
import { join } from "path";

import type { HarEntry } from "../capture/har";
import { locateMitmdump } from "../capture/mitm-engine";
import { simctlSync } from "../simctl";
import { e2eDevice, readInsert, requireE2E } from "./e2e-preconditions";
import { freePortAsync, killHelpersForDevice, useTempStateDir } from "./helpers";

const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");
const FIXTURE = join(PKG_DIR, "dist/capability-loader/ServeSimNetworkRequestFixture.app");
const DYLIB = join(PKG_DIR, "dist/simnet/libSimNetProxy.dylib");
const APP = "dev.expo.serve-sim.network-request-fixture";
const ORIGIN_ENV = "SERVE_SIM_NETWORK_FIXTURE_ORIGIN";
const PROFILE_PATH = "/api/profile?source=button";
const UPLOAD_PATH = "/api/upload";
const UPLOAD_BYTES = 3 * 1024 * 1024;
const CAPTURED_BODY_BYTES = 512 * 1024;

const udid = e2eDevice();
const ready =
  udid !== null
  && existsSync(CLI)
  && existsSync(FIXTURE)
  && existsSync(DYLIB)
  && locateMitmdump() !== null;
requireE2E("network request fixture", ready);

type ReceivedRequest = { method: string; url: string; bodyBytes: number; bodyStart: string };

async function waitForAsync(check: () => boolean | Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check()) && Date.now() < deadline) await Bun.sleep(250);
  expect(await check()).toBe(true);
}

const describeOrSkip = ready ? describe : describe.skip;

describeOrSkip("network request fixture", () => {
  let tempState: ReturnType<typeof useTempStateDir>;
  let origin: Server | undefined;
  let server: ChildProcess | undefined;
  let serverPort = 0;
  let stderr = "";
  const received: ReceivedRequest[] = [];

  beforeAll(async () => {
    tempState = useTempStateDir();
    killHelpersForDevice(udid!);

    try {
      simctlSync(["uninstall", udid!, APP]);
    } catch {}
    simctlSync(["install", udid!, FIXTURE], 60_000);

    const originPort = await freePortAsync();
    origin = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const requestBody = Buffer.concat(chunks);
        received.push({
          method: req.method ?? "",
          url: req.url ?? "",
          bodyBytes: requestBody.length,
          bodyStart: requestBody.subarray(0, 16).toString("utf-8"),
        });
        const body = JSON.stringify({ ok: true, path: req.url });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Serve-Sim-Fixture": "response",
        });
        res.end(body);
      });
    });
    await new Promise<void>((done) => origin!.listen(originPort, "127.0.0.1", done));
    simctlSync([
      "spawn",
      udid!,
      "launchctl",
      "setenv",
      ORIGIN_ENV,
      `http://127.0.0.1:${originPort}/`,
    ]);

    serverPort = await freePortAsync();
    server = spawn(
      "node",
      [
        CLI,
        "--network-capture",
        "--network-capture-field",
        "header",
        "--network-capture-field",
        "query",
        "--network-capture-field",
        "request-body",
        "--network-capture-field",
        "response-body",
        "--quiet",
        "--port",
        String(serverPort),
        "--launch-app-identifier",
        APP,
        udid!,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
    );
    server.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    await waitForAsync(() => existsSync(join(tempState.dir, `server-${udid!}.json`)));
    await Bun.sleep(1_000);
  }, 180_000);

  afterAll(async () => {
    if (server?.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          server?.kill("SIGKILL");
          done();
        }, 30_000);
        server!.on("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
    }
    try {
      try {
        simctlSync(["terminate", udid!, APP]);
      } catch {}
      try {
        simctlSync(["uninstall", udid!, APP]);
      } catch {}
      try {
        simctlSync(["spawn", udid!, "launchctl", "unsetenv", ORIGIN_ENV]);
      } catch {}
      if (origin) {
        origin.closeAllConnections();
        await new Promise<void>((done) => origin!.close(() => done()));
      }
      expect(readInsert(udid!), stderr).toBe("");
      expect(simctlSync(["spawn", udid!, "launchctl", "getenv", "SIMNET_PROXY_PORT_FILE"])).toBe("");
    } finally {
      tempState.restore();
    }
  }, 180_000);

  test("the two buttons send a small GET and large POST that appear in capture", async () => {
    const tap = (y: string) => execFileSync("node", [CLI, "tap", "0.5", y, "-d", udid!], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });

    tap("0.52");
    await waitForAsync(() => received.length === 1);
    tap("0.61");
    await waitForAsync(() => received.length === 2);
    expect(received).toHaveLength(2);
    expect(received).toContainEqual({
      method: "GET",
      url: PROFILE_PATH,
      bodyBytes: 0,
      bodyStart: "",
    });
    expect(received).toContainEqual({
      method: "POST",
      url: UPLOAD_PATH,
      bodyBytes: UPLOAD_BYTES,
      bodyStart: "xxxxxxxxxxxxxxxx",
    });

    const state = JSON.parse(
      readFileSync(join(tempState.dir, `server-${udid!}.json`), "utf-8"),
    ) as { token: string };
    const headers = {
      Authorization: `Bearer ${state.token}`,
      Origin: `http://127.0.0.1:${serverPort}`,
    };
    let entries: HarEntry[] = [];
    await waitForAsync(async () => {
      const response = await fetch(
        `http://127.0.0.1:${serverPort}/network-capture.har?device=${udid!}`,
        { headers },
      );
      entries = ((await response.json()) as { log: { entries: HarEntry[] } }).log.entries;
      return entries.filter((entry) => entry.request.url.includes("/api/")).length === 2;
    });

    const profile = entries.find((entry) => entry.request.url.endsWith(PROFILE_PATH));
    const upload = entries.find((entry) => entry.request.url.endsWith(UPLOAD_PATH));
    expect(profile).toMatchObject({ request: { method: "GET" }, response: { status: 200 } });
    expect(upload).toMatchObject({
      request: {
        method: "POST",
        bodySize: UPLOAD_BYTES,
      },
      response: { status: 200 },
    });
    expect(upload?.request.postData?.text).toHaveLength(CAPTURED_BODY_BYTES);
    const capturedBody = await fetch(
      `http://127.0.0.1:${serverPort}/network-capture/${upload!._captureId}?device=${udid!}`,
      { headers },
    ).then((response) => response.json()) as { requestBody: string; requestTruncated: boolean };
    expect(capturedBody.requestBody).toHaveLength(CAPTURED_BODY_BYTES);
    expect(capturedBody.requestTruncated).toBe(true);

    const container = simctlSync(["get_app_container", udid!, APP, "data"]);
    const resultsPath = join(container, "Documents/network-requests.tsv");
    let appResults = "";
    await waitForAsync(() => {
      if (!existsSync(resultsPath)) return false;
      appResults = readFileSync(resultsPath, "utf-8");
      return appResults.split("\n").filter(Boolean).length === 2;
    });
    expect(appResults).toContain("GET /api/profile → 200");
    expect(appResults).toContain("POST /api/upload → 200");
  }, 180_000);
});
