import { describe, expect, it } from "bun:test";

import { InvalidHostActionError, runHostActionAsync } from "../host-actions";

// `true` ignores its arguments and exits 0, so these assert the validation layer without running
// simctl. Argument construction itself is covered by the CLI-backed actions below.
const BIN = "true";

describe("runHostActionAsync validation", () => {
  it("refuses an unknown action", async () => {
    await expect(runHostActionAsync({ action: "shell.run" }, BIN)).rejects.toBeInstanceOf(
      InvalidHostActionError,
    );
  });

  it("refuses a missing action", async () => {
    await expect(runHostActionAsync({}, BIN)).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("refuses a required param that is missing or empty", async () => {
    await expect(runHostActionAsync({ action: "appearance.get" }, BIN)).rejects.toBeInstanceOf(
      InvalidHostActionError,
    );
    await expect(
      runHostActionAsync({ action: "appearance.get", params: { udid: "" } }, BIN),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("refuses a value outside the allowed set", async () => {
    await expect(
      runHostActionAsync(
        { action: "appearance.set", params: { udid: "U", value: "rm -rf /" } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  // Validation passes, so this reaches xcrun and comes back as a result rather than a throw.
  it("accepts an allowed value", async () => {
    await expect(
      runHostActionAsync({ action: "appearance.set", params: { udid: "U", value: "dark" } }, BIN),
    ).resolves.toMatchObject({ exitCode: expect.any(Number) });
  });

  // The whole point of execFile: a param that would be a metacharacter in a shell is just an
  // argument here, so it cannot start a second command.
  it("treats shell metacharacters in a param as literal text", async () => {
    const result = await runHostActionAsync(
      { action: "permissions.resetAll", params: { bundleId: "a; touch /tmp/pwned", udid: "U" } },
      "echo",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("a; touch /tmp/pwned");
    expect(result.stdout).toContain("permissions reset all");
  });

  it("runs a .ts entrypoint through bun rather than executing it directly", async () => {
    const result = await runHostActionAsync(
      { action: "camera.listWebcams" },
      "/does/not/exist/serve-sim.ts",
    );

    expect(result.exitCode).not.toBe(0);
  });
});
