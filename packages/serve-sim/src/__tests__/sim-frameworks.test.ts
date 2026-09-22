import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { requireE2E } from "./e2e-preconditions";

const ADDON = join(import.meta.dir, "../../dist/native/serve-sim-native.node");
const NATIVE = join(import.meta.dir, "../native.ts");

function runWithDeveloperDir(developerDir: string, script: string): string {
  const result = spawnSync("bun", ["-e", script], {
    encoding: "utf-8",
    env: { ...process.env, DEVELOPER_DIR: developerDir },
  });
  return `${result.stdout}${result.stderr}`;
}

const ready = existsSync(ADDON);
requireE2E("sim frameworks", ready);
const describeIfBuilt = ready ? describe : describe.skip;

describeIfBuilt("private simulator frameworks", () => {
  test("report which SimulatorKit candidates failed for a missing Xcode", () => {
    const out = runWithDeveloperDir(
      "/nonexistent/Developer",
      `const { frameworkStatusAsync } = await import(${JSON.stringify(NATIVE)});
       const status = await frameworkStatusAsync();
       console.log(JSON.stringify({ simulatorKit: status.simulatorKit, failed: status.attempts.filter((a) => a.error).map((a) => a.path) }));`,
    );
    expect(JSON.parse(out.trim().split("\n").at(-1) ?? "{}")).toEqual({
      simulatorKit: null,
      failed: [
        "/nonexistent/Developer/../SharedFrameworks/SimulatorKit.framework/SimulatorKit",
        "/nonexistent/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
      ],
    });
  });

  test("native calls name the missing framework instead of a missing device", () => {
    const out = runWithDeveloperDir(
      "/nonexistent/Developer",
      `const { axFrontmostAsync } = await import(${JSON.stringify(NATIVE)});
       await axFrontmostAsync("00000000-0000-0000-0000-000000000000").then(
         () => console.log("resolved"),
         (error) => console.log(String(error.message ?? error)),
       );`,
    );
    expect(out).toContain("serve-sim could not load SimulatorKit (active Xcode: /nonexistent/Developer)");
    expect(out).not.toContain("Device 00000000-0000-0000-0000-000000000000 not found");
  });
});
