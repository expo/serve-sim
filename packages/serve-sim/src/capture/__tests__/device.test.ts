import { afterEach, beforeEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { isDeviceInjected, proxyDylibCandidates } from "../device";
import { useTempStateDir } from "../../__tests__/helpers";
import { writeLaunchState } from "../../launch-state";
import { capabilityConfigPath, commitCapabilityConfig, renderCapabilityConfig } from "../../capability-config";
import { capabilityLoaderPath } from "../../launch-manager";

const UDID = "ABCD1234-0000-0000-0000-0000000000EF";
const PORT_FILE = "/tmp/serve-sim-confdir/proxy-port";
const DYLIB = "/opt/libSimNetProxy.dylib";
let tempState: ReturnType<typeof useTempStateDir>;
beforeEach(() => {
  tempState = useTempStateDir();
  const state = {
    launchArgs: [],
    capabilities: {
      networkCapture: {
        name: "networkCapture", dylib: DYLIB, scope: "userApps" as const,
        loadPhase: "startup" as const, ownerPid: null, bundleId: null,
        env: { SIMNET_PROXY_PORT_FILE: PORT_FILE },
      },
    },
  };
  writeLaunchState(UDID, state);
  commitCapabilityConfig(UDID, renderCapabilityConfig(state));
});
afterEach(() => tempState.restore());

const readEnv = (inserts: string) => async (args: string[]) =>
  args.at(-1) === "SERVE_SIM_CAPABILITIES_CONFIG" ? capabilityConfigPath(UDID) : inserts;

test("capture is healthy when its session and startup images are armed", async () => {
  expect(await isDeviceInjected(UDID, PORT_FILE, {
    read: readEnv(`${capabilityLoaderPath()}:${DYLIB}`),
  })).toBe(true);
});

test("capture is unhealthy when the startup image is removed", async () => {
  expect(await isDeviceInjected(UDID, PORT_FILE, {
    read: readEnv(capabilityLoaderPath()),
  })).toBe(false);
});

test("capture is unhealthy when the port file belongs to another session", async () => {
  expect(await isDeviceInjected(UDID, "/tmp/other-confdir/proxy-port", {
    read: readEnv(`${capabilityLoaderPath()}:${DYLIB}`),
  })).toBe(false);
});

test("proxyDylibCandidates includes the checkout's native build", () => {
  expect(proxyDylibCandidates()).toContain(resolve(import.meta.dir, "../../../dist/simnet/libSimNetProxy.dylib"));
});
