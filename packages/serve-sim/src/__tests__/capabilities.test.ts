import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  capabilitiesToApply,
  clearRegisteredCapabilities,
  registerCapability,
  registeredCapabilities,
  UnknownCapabilityError,
} from "../capabilities";
import type { CapabilityDefinition } from "../capabilities";
import { applyDefaultCapabilities } from "../launch-manager";

function register(name: string, defaultEnabled: boolean): void {
  registerCapability({
    name,
    defaultEnabled,
    resolve: async () => ({ name, dylib: `/${name}.dylib` }),
  });
}

beforeEach(() => {
  clearRegisteredCapabilities();
  register("on-by-default", true);
  register("off-by-default", false);
});

afterEach(() => {
  clearRegisteredCapabilities();
});

function names(overrides: Parameters<typeof capabilitiesToApply>[0]): string[] {
  return capabilitiesToApply(overrides).map((definition) => definition.name);
}

describe("capabilitiesToApply", () => {
  test("applies the ones registered as on by default", () => {
    expect(names({})).toContain("on-by-default");
    expect(names({})).not.toContain("off-by-default");
  });

  test("--enable turns on one that is off by default", () => {
    expect(names({ enable: ["off-by-default"] })).toContain("off-by-default");
  });

  test("--disable turns off one that is on by default", () => {
    expect(names({ disable: ["on-by-default"] })).not.toContain("on-by-default");
  });

  test("--disable wins when a capability is named twice", () => {
    expect(names({ enable: ["on-by-default"], disable: ["on-by-default"] })).not.toContain(
      "on-by-default",
    );
  });

  test("rejects a name nobody registered", () => {
    expect(() => capabilitiesToApply({ enable: ["nope"] })).toThrow(UnknownCapabilityError);
    expect(() => capabilitiesToApply({ enable: ["nope"] })).toThrow("Available:");
  });
});

describe("registeredCapabilities", () => {
  test("registering the same name twice replaces rather than duplicates", () => {
    register("on-by-default", false);
    const matches = registeredCapabilities().filter((d) => d.name === "on-by-default");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.defaultEnabled).toBe(false);
  });
});

describe("applyDefaultCapabilities", () => {
  // enableCapabilities reaches simctl, so these keep every survivor declining.
  // What is under test is that one bad definition does not stop the others being
  // asked, which the resolved list reports.
  function askedFor(name: string, resolve: CapabilityDefinition["resolve"]): string[] {
    const asked: string[] = [];
    clearRegisteredCapabilities();
    registerCapability({
      name,
      defaultEnabled: true,
      resolve: async (udid, bundleId) => {
        asked.push(name);
        return await resolve(udid, bundleId);
      },
    });
    registerCapability({
      name: "also-on",
      defaultEnabled: true,
      resolve: async () => {
        asked.push("also-on");
        return null;
      },
    });
    return asked;
  }

  test("a capability that declines degrades to off rather than failing the launch", async () => {
    const asked = askedFor("declines", async () => null);

    expect(await applyDefaultCapabilities("NOT-A-DEVICE", "com.example.app")).toEqual([]);
    expect(asked).toEqual(["also-on", "declines"]);
  });

  test("a capability that throws while preparing does not take the others down", async () => {
    const asked = askedFor("throws", async () => {
      throw new Error("no hardware for this");
    });

    expect(await applyDefaultCapabilities("NOT-A-DEVICE", "com.example.app")).toEqual([]);
    expect(asked).toContain("also-on");
  });
});
