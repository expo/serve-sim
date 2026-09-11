import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { bootInjectionCleared, clearBootInjection, injectAtBoot, proxyDylibCandidates } from "../device";

const UDID = "ABCD1234-0000-0000-0000-0000000000EF";

describe("clearBootInjection", () => {
  test("unsets both variables when nothing else is injected", async () => {
    const calls: string[][] = [];
    await clearBootInjection(UDID, {
      run: async (args) => {
        calls.push(args);
        return args.includes("getenv") ? "/opt/serve-sim/libSimNetProxy.dylib" : "";
      },
    });

    const unset = calls.filter((args) => args.includes("unsetenv")).map((args) => args.at(-1));
    expect(unset).toEqual(["DYLD_INSERT_LIBRARIES", "SIMNET_PROXY_PORT_FILE"]);
  });

  test("leaves another tool's library in the list", async () => {
    const calls: string[][] = [];
    await clearBootInjection(UDID, {
      run: async (args) => {
        calls.push(args);
        return args.includes("getenv")
          ? "/opt/loader/libServeSimCapabilityLoader.dylib:/opt/serve-sim/libSimNetProxy.dylib"
          : "";
      },
    });

    const setenv = calls.find((args) => args.includes("setenv") && args.includes("DYLD_INSERT_LIBRARIES"));
    expect(setenv?.at(-1)).toBe("/opt/loader/libServeSimCapabilityLoader.dylib");
    expect(calls.some((args) => args.includes("unsetenv") && args.includes("DYLD_INSERT_LIBRARIES"))).toBe(
      false,
    );
  });

  test("stops clearing once the device turns out to be gone", async () => {
    const attempted: string[] = [];
    await clearBootInjection(UDID, {
      run: async (args) => {
        attempted.push(args.at(-1)!);
        throw new Error("Unable to lookup device: Invalid device");
      },
    });

    // The remaining variable went with the device, so it is not attempted or reported.
    expect(new Set(attempted)).toEqual(new Set(["DYLD_INSERT_LIBRARIES"]));
  });

  test("does not treat a live device or a broken toolchain as gone", async () => {
    // `Booted` also appears in "rebooted"; `not found` in "launchctl: command not found".
    for (const message of ["current state: Booted", "launchctl: command not found"]) {
      await expect(
        clearBootInjection(UDID, {
          run: async () => {
            throw new Error(message);
          },
        }),
      ).rejects.toThrow(/still load the capture library/);
    }
  });

  test("reports any other failure instead of claiming a clean teardown", async () => {
    // Silently swallowing this is how a device stays injected while the runtime says it stopped.
    const attempt = clearBootInjection(UDID, {
      run: async () => {
        throw new Error("launchctl: permission denied");
      },
    });

    await expect(attempt).rejects.toThrow(/still load the capture library/);
  });

  test("names the variable, the device and the recovery in the failure", async () => {
    const attempt = clearBootInjection(UDID, {
      run: async () => {
        throw new Error("boom");
      },
    });

    // One rejected promise can be asserted repeatedly; the udid is what tells you which device to reboot.
    await expect(attempt).rejects.toThrow(/DYLD_INSERT_LIBRARIES/);
    await expect(attempt).rejects.toThrow(new RegExp(UDID));
    await expect(attempt).rejects.toThrow(/Reboot the device/);
  });
});

describe("bootInjectionCleared", () => {
  test("is true when the device reports nothing for either variable", async () => {
    expect(await bootInjectionCleared(UDID, { read: async () => "" })).toBe(true);
  });

  test("ignores the injected library's own log lines", async () => {
    // The dylib logs from every process it loads into, including this `launchctl`.
    const noise = "2026-08-06 launchctl[1]: [simnetproxy] loaded into pid 1\n";

    expect(await bootInjectionCleared(UDID, { read: async () => noise })).toBe(true);
  });

  test("is false while a variable still has a value", async () => {
    expect(
      await bootInjectionCleared(UDID, { read: async () => "/path/to/libSimNetProxy.dylib\n" }),
    ).toBe(false);
  });

  test("treats an unreadable device as cleared rather than as still injected", async () => {
    expect(
      await bootInjectionCleared(UDID, {
        read: async () => {
          throw new Error("Unable to lookup device");
        },
      }),
    ).toBe(true);
  });
});

describe("proxyDylibCandidates", () => {
  test("includes the path a checkout actually builds to", () => {
    // Both original candidates resolved under src/, so running from source never found the dylib.
    const fromSource = resolve(import.meta.dir, "../../../dist/simnet/libSimNetProxy.dylib");

    expect(proxyDylibCandidates()).toContain(fromSource);
  });
});

describe("injectAtBoot", () => {
  const DYLIB = "/opt/serve-sim/libSimNetProxy.dylib";

  test("keeps another tool's library when it arms the device", async () => {
    const calls: string[][] = [];
    await injectAtBoot(UDID, "/tmp/port", {
      dylib: () => DYLIB,
      run: async (args) => {
        calls.push(args);
        return args.includes("getenv") ? "/opt/loader/libServeSimCapabilityLoader.dylib" : "";
      },
    });

    const setenv = calls.find((args) => args.includes("setenv") && args.includes("DYLD_INSERT_LIBRARIES"));
    expect(setenv?.at(-1)).toBe(`/opt/loader/libServeSimCapabilityLoader.dylib:${DYLIB}`);
  });

  test("does not list itself twice when the device is already armed", async () => {
    const calls: string[][] = [];
    await injectAtBoot(UDID, "/tmp/port", {
      dylib: () => DYLIB,
      run: async (args) => {
        calls.push(args);
        return args.includes("getenv") ? DYLIB : "";
      },
    });

    const setenv = calls.find((args) => args.includes("setenv") && args.includes("DYLD_INSERT_LIBRARIES"));
    expect(setenv?.at(-1)).toBe(DYLIB);
  });
});
