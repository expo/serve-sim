// Proves the injected dylib actually routes an app's traffic through the capture proxy.
//
// Every other capture test fakes this step, so a swizzle that stopped working — an OS change, or the
// undocumented HTTPS proxy keys being ignored — would leave the whole suite green while the panel showed
// an empty list. Here a real app runs in a real simulator and its request has to arrive on a real socket.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { e2eDevice, requireE2E } from "./e2e-preconditions";

const BUNDLE_ID = "dev.expo.serve-sim.simnet-probe";
const PROBE_HOST = "simnet-probe.test";
const DYLIB = resolve(import.meta.dir, "../../dist/simnet/libSimNetProxy.dylib");
const PROBE_APP = resolve(import.meta.dir, "../../dist/capability-loader/SimNetProbe.app");

const udid = e2eDevice();
const canRun = !!udid && existsSync(DYLIB) && existsSync(PROBE_APP);
const describeOrSkip = canRun ? describe : describe.skip;
requireE2E("simnet injection", canRun);

interface Probe {
  port: number;
  /** The first line the app sent, or null if it never connected. */
  firstLine: (timeoutMs: number) => Promise<string | null>;
  close: () => void;
}

/** A socket standing in for the capture proxy, so the assertion is on bytes the app actually sent. */
async function proxyStandIn(): Promise<Probe> {
  let resolveFirst: (value: string | null) => void = () => {};
  const first = new Promise<string | null>((r) => {
    resolveFirst = r;
  });

  const server: Server = createServer((socket) => {
    socket.once("data", (chunk) => {
      resolveFirst(chunk.toString("latin1").split("\r\n")[0]!);
      socket.destroy();
    });
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");

  return {
    port: address.port,
    firstLine: (timeoutMs) =>
      Promise.race([
        first,
        new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
      ]),
    close: () => server.close(),
  };
}

function launchProbeApp(
  port: number,
  { inject, portFile }: { inject: boolean; portFile?: string },
): void {
  execFileSync("xcrun", ["simctl", "launch", udid!, BUNDLE_ID], {
    stdio: "pipe",
    timeout: 30_000,
    env: {
      ...process.env,
      // Empty rather than absent: the simulator's launchd may carry an injection of its own, and the
      // control case has to prove this app was not proxied by anything.
      SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: inject ? DYLIB : "",
      // A device booted for capture is given the file; the bare port is the single-launch form.
      ...(inject
        ? portFile
          ? { SIMCTL_CHILD_SIMNET_PROXY_PORT_FILE: portFile }
          : { SIMCTL_CHILD_SIMNET_PROXY_PORT: String(port) }
        : { SIMCTL_CHILD_SIMNET_PROXY_PORT: "", SIMCTL_CHILD_SIMNET_PROXY_PORT_FILE: "" }),
      SIMCTL_CHILD_SIMNET_PROBE_URL: `https://${PROBE_HOST}/ping`,
    },
  });
}

function terminateProbeApp(): void {
  spawnSync("xcrun", ["simctl", "terminate", udid!, BUNDLE_ID], { stdio: "ignore" });
}

let appDir = "";

describeOrSkip("SimNetProxy injection (real simulator)", () => {
  beforeAll(() => {
    // A device left injected by an earlier run would decide these results instead of the test.
    for (const name of ["DYLD_INSERT_LIBRARIES", "SIMNET_PROXY_PORT", "SIMNET_PROXY_PORT_FILE"]) {
      spawnSync("xcrun", ["simctl", "spawn", udid!, "launchctl", "unsetenv", name], { stdio: "ignore" });
    }
    appDir = mkdtempSync(join(tmpdir(), "simnet-probe-"));
    execFileSync("xcrun", ["simctl", "install", udid!, PROBE_APP], {
      stdio: "pipe",
      timeout: 60_000,
    });
  }, 240_000);

  afterAll(() => {
    // The fixture app is the only thing this test adds to the device, and it does not outlive the test.
    terminateProbeApp();
    spawnSync("xcrun", ["simctl", "uninstall", udid!, BUNDLE_ID], { stdio: "ignore" });
    // Only the port files this test writes; the app itself comes from dist.
    if (appDir) rmSync(appDir, { recursive: true, force: true });
  });

  it(
    "sends the app's HTTPS request to the proxy as a CONNECT",
    async () => {
      const probe = await proxyStandIn();
      try {
        terminateProbeApp();
        launchProbeApp(probe.port, { inject: true });

        const line = await probe.firstLine(25_000);
        // A CONNECT proves the HTTPS keys took effect. Those keys have no public constants on iOS, so
        // this is the assertion that catches CFNetwork ignoring them.
        expect(line).not.toBeNull();
        expect(line).toStartWith(`CONNECT ${PROBE_HOST}:443`);
      } finally {
        probe.close();
      }
    },
    60_000,
  );

  it(
    "reads the port from a file, which is how a device booted for capture is pointed at the proxy",
    async () => {
      const probe = await proxyStandIn();
      const portFile = join(appDir, "proxy-port");
      writeFileSync(portFile, String(probe.port));
      try {
        terminateProbeApp();
        launchProbeApp(probe.port, { inject: true, portFile });

        const line = await probe.firstLine(25_000);
        expect(line).toStartWith(`CONNECT ${PROBE_HOST}:443`);
      } finally {
        probe.close();
        rmSync(portFile, { force: true });
      }
    },
    60_000,
  );

  it(
    "leaves the app unproxied once the port file is gone",
    async () => {
      const probe = await proxyStandIn();
      const missing = join(appDir, "proxy-port-that-was-removed");
      rmSync(missing, { force: true });
      try {
        terminateProbeApp();
        launchProbeApp(probe.port, { inject: true, portFile: missing });

        // This is what makes a crashed proxy safe: the file dies with it, so an app launched afterwards
        // finds nothing and leaves its own networking alone rather than trusting a stale port number.
        expect(await probe.firstLine(8_000)).toBeNull();
      } finally {
        probe.close();
      }
    },
    60_000,
  );

  it(
    "leaves the app alone when the dylib is not injected",
    async () => {
      const probe = await proxyStandIn();
      try {
        terminateProbeApp();
        launchProbeApp(probe.port, { inject: false });

        // Without this control the test above would pass even if something other than the dylib were
        // routing the traffic.
        expect(await probe.firstLine(8_000)).toBeNull();
      } finally {
        probe.close();
      }
    },
    60_000,
  );
});
