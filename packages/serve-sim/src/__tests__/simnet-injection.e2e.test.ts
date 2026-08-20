// Proves the injected dylib actually routes an app's traffic through the capture proxy.
//
// Every other capture test fakes this step, so a swizzle that stopped working — an OS change, or the
// undocumented HTTPS proxy keys being ignored — would leave the whole suite green while the panel showed
// an empty list. Here a real app runs in a real simulator and its request has to arrive on a real socket.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const BUNDLE_ID = "dev.expo.serve-sim.simnet-probe";
const PROBE_HOST = "simnet-probe.test";
const DYLIB = resolve(import.meta.dir, "../../dist/simnet/libSimNetProxy.dylib");
const BUILD_SCRIPT = resolve(import.meta.dir, "fixtures/SimNetProbe/build.sh");

function firstBootedIosSim(): string | null {
  try {
    const raw = execFileSync("xcrun", ["simctl", "list", "devices", "booted", "-j"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed: { devices?: Record<string, { udid?: string }[]> } = JSON.parse(raw);
    for (const devices of Object.values(parsed.devices ?? {})) {
      for (const device of devices) if (device.udid) return device.udid;
    }
  } catch {
    // No Xcode, or no booted device; the suite skips.
  }
  return null;
}

const udid = firstBootedIosSim();
const canRun = !!udid && existsSync(DYLIB);
const describeOrSkip = canRun ? describe : describe.skip;
if (!canRun) {
  console.warn(
    `[simnet-injection.e2e] skipping: ${udid ? "run the build first, dist/simnet is missing" : "no booted iOS simulator"}`,
  );
}

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
    chmodSync(BUILD_SCRIPT, 0o755);
    execFileSync("bash", [BUILD_SCRIPT, appDir], { stdio: "pipe", timeout: 180_000 });
    execFileSync("xcrun", ["simctl", "install", udid!, join(appDir, "SimNetProbe.app")], {
      stdio: "pipe",
      timeout: 60_000,
    });
  }, 240_000);

  afterAll(() => {
    // The fixture app is the only thing this test adds to the device, and it does not outlive the test.
    terminateProbeApp();
    spawnSync("xcrun", ["simctl", "uninstall", udid!, BUNDLE_ID], { stdio: "ignore" });
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
