import { beforeEach, describe, expect, test } from "bun:test";

import {
  capabilitiesToApply,
  registerCapability,
  registeredCapabilities,
  UnknownCapabilityError,
} from "../capabilities";

function register(name: string, defaultEnabled: boolean): void {
  registerCapability({
    name,
    defaultEnabled,
    resolve: async () => ({ name, dylib: `/${name}.dylib` }),
  });
}

beforeEach(() => {
  register("on-by-default", true);
  register("off-by-default", false);
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
