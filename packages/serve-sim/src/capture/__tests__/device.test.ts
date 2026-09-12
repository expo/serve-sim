import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { bootInjectionCleared, clearBootInjection, injectAtBoot, proxyDylibCandidates } from "../device";
import { installShims, useTempStateDir } from "../../__tests__/helpers";
import { withLaunchStateLock } from "../../launch-state-lock";

const UDID = "ABCD1234-0000-0000-0000-0000000000EF";

let tempState: ReturnType<typeof useTempStateDir>;
beforeAll(() => {
  tempState = useTempStateDir();
});
afterAll(() => {
  tempState.restore();
});

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

  test("passes the value simctl printed, not the result object", async () => {
    const LOADER = "/opt/loader/libServeSimCapabilityLoader.dylib";
    const log = join(tempState.dir, "xcrun-calls.txt");
    const shims = installShims({
      xcrun:
        `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\n` +
        `case "$*" in *getenv*) echo "${LOADER}";; esac\n`,
    });
    try {
      await injectAtBoot(UDID, "/tmp/port", { dylib: () => DYLIB });
      const setenv = readFileSync(log, "utf8")
        .split("\n")
        .find((line) => line.includes("setenv DYLD_INSERT_LIBRARIES"));
      expect(setenv).toBe(
        `simctl spawn ${UDID} launchctl setenv DYLD_INSERT_LIBRARIES ${LOADER}:${DYLIB}`,
      );
    } finally {
      shims.restore();
    }
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


describe("concurrent arming", () => {
  const DYLIB = "/opt/serve-sim/libSimNetProxy.dylib";
  test("keeps the capability loader's entry when it arms at the same time", async () => {
    const LOADER = "/opt/loader/libServeSimCapabilityLoader.dylib";
    const env = new Map<string, string>();
    const log = join(tempState.dir, "race-calls.txt");
    const shims = installShims({
      xcrun: `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\n` + `exit 0\n`,
    });
    try {
      const run = async (args: string[]): Promise<string> => {
        const name = args.at(-2) ?? "";
        if (args.includes("getenv")) return env.get(args.at(-1) ?? "") ?? "";
        if (args.includes("setenv")) {
          await new Promise((done) => setTimeout(done, 5));
          env.set(name, args.at(-1) ?? "");
        }
        return "";
      };
      const armLoader = () =>
        withLaunchStateLock(UDID, async () => {
          const current = env.get("DYLD_INSERT_LIBRARIES") ?? "";
          await new Promise((done) => setTimeout(done, 5));
          env.set("DYLD_INSERT_LIBRARIES", [current, LOADER].filter(Boolean).join(":"));
        });

      await Promise.all([injectAtBoot(UDID, "/tmp/port", { dylib: () => DYLIB, run }), armLoader()]);

      const entries = (env.get("DYLD_INSERT_LIBRARIES") ?? "").split(":").filter(Boolean);
      expect(entries).toContain(LOADER);
      expect(entries).toContain(DYLIB);
      expect(env.get("SIMNET_PROXY_PORT_FILE")).toBe("/tmp/port");
    } finally {
      shims.restore();
    }
  });

  test("keeps a loader that arms while the last capture entry is cleared", async () => {
    const LOADER = "/opt/loader/libServeSimCapabilityLoader.dylib";
    const env = new Map<string, string>([["DYLD_INSERT_LIBRARIES", DYLIB]]);
    const log = join(tempState.dir, "teardown-race-calls.txt");
    const shims = installShims({
      xcrun: `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\n` + `exit 0\n`,
    });
    try {
      const run = async (args: string[]): Promise<string> => {
        const name = args.at(-1) ?? "";
        if (args.includes("getenv")) return env.get(name) ?? "";
        if (args.includes("setenv")) {
          await new Promise((done) => setTimeout(done, 5));
          env.set(args.at(-2) ?? "", name);
        }
        if (args.includes("unsetenv")) {
          // Slower than the lock's poll interval, so a released lock is taken before this lands.
          await new Promise((done) => setTimeout(done, 200));
          env.delete(name);
        }
        return "";
      };
      const armLoader = () =>
        withLaunchStateLock(UDID, async () => {
          const current = env.get("DYLD_INSERT_LIBRARIES") ?? "";
          await new Promise((done) => setTimeout(done, 5));
          env.set("DYLD_INSERT_LIBRARIES", [current, LOADER].filter(Boolean).join(":"));
        });

      await Promise.all([clearBootInjection(UDID, { run }), armLoader()]);

      expect((env.get("DYLD_INSERT_LIBRARIES") ?? "").split(":").filter(Boolean)).toEqual([LOADER]);
      // Both variables clear together, or the device reads as injected with nothing to route to.
      expect(env.has("SIMNET_PROXY_PORT_FILE")).toBe(false);
    } finally {
      shims.restore();
    }
  });
});
