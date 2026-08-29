import { describe, expect, test } from "bun:test";

import { installAndLaunchApp } from "../launch-app";

describe("installAndLaunchApp", () => {
  test("reads, installs, and launches the app", async () => {
    const calls: Array<{ file: string; args: string[]; timeout: number }> = [];
    const launches: Array<{ udid: string; bundleId: string }> = [];
    const result = await installAndLaunchApp(
      "DEVICE-A",
      "/tmp/My App.app",
      async (udid, bundleId) => {
        launches.push({ udid, bundleId });
        return 42;
      },
      {
        exists: () => true,
        run: async (file, args, timeout) => {
          calls.push({ file, args, timeout });
          return { stdout: file === "plutil" ? "dev.expo.myapp\n" : "" };
        },
      },
    );

    expect(calls).toEqual([
      {
        file: "plutil",
        args: [
          "-extract",
          "CFBundleIdentifier",
          "raw",
          "-o",
          "-",
          "/tmp/My App.app/Info.plist",
        ],
        timeout: 5000,
      },
      {
        file: "xcrun",
        args: ["simctl", "install", "DEVICE-A", "/tmp/My App.app"],
        timeout: 120_000,
      },
    ]);
    expect(launches).toEqual([{ udid: "DEVICE-A", bundleId: "dev.expo.myapp" }]);
    expect(result).toEqual({ bundleId: "dev.expo.myapp", pid: 42 });
  });

  test("rejects a path without an Info.plist", async () => {
    await expect(
      installAndLaunchApp("DEVICE-A", "/tmp/Bad.app", async () => null, {
        exists: () => false,
      }),
    ).rejects.toThrow("Invalid app bundle");
  });

  test("rejects an app without a bundle identifier", async () => {
    await expect(
      installAndLaunchApp("DEVICE-A", "/tmp/Bad.app", async () => null, {
        exists: () => true,
        run: async () => ({ stdout: "" }),
      }),
    ).rejects.toThrow("CFBundleIdentifier is missing");
  });
});
