import { expect, test } from "bun:test";
import { execFileSync } from "child_process";

import { findBootedDevice } from "../device";

/**
 * The device an e2e test should drive, or null when there is none. Pinning with
 * SERVE_SIM_TEST_UDID matters because other sessions share these simulators, but
 * a pin that is not booted has to read as "no device" rather than run every test
 * against nothing.
 */
export function e2eDevice(): string | null {
  const pinned = process.env.SERVE_SIM_TEST_UDID?.trim();
  const udid = pinned && pinned.length > 0 ? pinned : findBootedDevice();
  if (!udid) return null;
  try {
    const out = execFileSync("xcrun", ["simctl", "list", "devices", "booted", "-j"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    return out.includes(udid) ? udid : null;
  } catch {
    return null;
  }
}

/**
 * A device test that quietly skips is worse than one that fails: CI stays green
 * while the feature goes uncovered. Every e2e file declares what it needs, and
 * under SERVE_SIM_E2E_REQUIRED an unmet requirement fails instead of skipping.
 */
export function requireE2E(what: string, ready: boolean): void {
  test(`preconditions for ${what}`, () => {
    if (process.env.SERVE_SIM_E2E_REQUIRED) {
      expect(ready, `${what} cannot run here, and this environment requires it`).toBe(true);
    } else if (!ready) {
      console.warn(`skipping ${what}: no booted simulator or missing build artifacts`);
    }
  });
}
