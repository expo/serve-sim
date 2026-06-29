import { describe, expect, test } from "bun:test";
import {
  buildNgrokDomain,
  randomTunnelLabel,
  validateTunnelCliOptions,
} from "../tunnel";

describe("randomTunnelLabel", () => {
  test("normalizes labels for ngrok wildcard domains", () => {
    const label = randomTunnelLabel("Sim ABCD-1234!");

    expect(label).toMatch(/^sim-abcd-1234-[a-f0-9]{8}$/);
  });
});

describe("buildNgrokDomain", () => {
  test("strips protocol, wildcard prefix, and trailing slash", () => {
    expect(buildNgrokDomain("https://*.expo-simulator.ngrok.dev/")).toBe(
      "expo-simulator.ngrok.dev",
    );
  });

  test("prepends a generated label for wildcard domains", () => {
    expect(buildNgrokDomain("*.expo-simulator.ngrok.dev", "sim-1234")).toBe(
      "sim-1234.expo-simulator.ngrok.dev",
    );
  });
});

describe("validateTunnelCliOptions", () => {
  test("allows plain ngrok preview tunnels", () => {
    expect(validateTunnelCliOptions({ tunnel: true })).toBeNull();
  });

  test("rejects tunnel domain without tunnel", () => {
    expect(validateTunnelCliOptions({ tunnelDomain: "expo-simulator.ngrok.dev" })).toBe(
      "--tunnel-domain requires --tunnel.",
    );
  });

  test("rejects tunnels in detach mode", () => {
    expect(validateTunnelCliOptions({ tunnel: true, detach: true })).toBe(
      "--tunnel starts a preview tunnel and cannot be combined with --detach.",
    );
  });

  test("rejects tunnels without the preview server", () => {
    expect(validateTunnelCliOptions({ tunnel: true, preview: false })).toBe(
      "--tunnel starts a preview tunnel and cannot be combined with --no-preview.",
    );
  });
});
