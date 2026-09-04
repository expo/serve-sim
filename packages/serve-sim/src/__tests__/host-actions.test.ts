import { describe, expect, it } from "bun:test";

import { rmSync, symlinkSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { join } from "path";

import { InvalidHostActionError, runHostActionAsync } from "../host-actions";

// `true` ignores its arguments and exits 0, so these assert validation without running simctl.
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

  it("rejects a bundle id carrying shell metacharacters", async () => {
    await expect(
      runHostActionAsync(
        { action: "permissions.resetAll", params: { bundleId: "a; touch /tmp/pwned", udid: "U" } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("rejects a path outside the paths the preview may read", async () => {
    await expect(
      runHostActionAsync({ action: "file.readBase64", params: { path: "/etc/passwd" } }, BIN),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
    await expect(
      runHostActionAsync(
        { action: "file.readBase64", params: { path: `${homedir()}/Desktop/../../.ssh/id_rsa` } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("rejects an argument that would be read as a flag", async () => {
    await expect(
      runHostActionAsync({ action: "server.detach", params: { udid: "--host=0.0.0.0" } }, BIN),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  // execFile takes an argument vector, so a shell metacharacter arrives as one argument.
  it("passes params through as literal arguments to a real spawn", async () => {
    const result = await runHostActionAsync(
      {
        action: "permissions.set",
        params: { udid: "U", bundleId: "com.example.app", action: "grant", service: "camera" },
      },
      "echo",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("permissions grant camera com.example.app");
  });

  it("rejects an uploadId that tries to traverse out of the upload directory", async () => {
    for (const uploadId of ["../../evil", "a/b", ".hidden"]) {
      await expect(
        runHostActionAsync({ action: "upload.append", params: { uploadId, data: "aGk=" } }, BIN),
      ).rejects.toBeInstanceOf(InvalidHostActionError);
    }
  });

  // The fiddliest schema here; reaching simctl means the params were accepted.
  it("accepts a staged upload as an install source", async () => {
    await expect(
      runHostActionAsync({ action: "app.install", params: { udid: "U", uploadId: "app.ipa" } }, BIN),
    ).resolves.toMatchObject({ exitCode: expect.any(Number) });
  });

  it("rejects an install with neither an upload nor a path", async () => {
    await expect(
      runHostActionAsync({ action: "app.install", params: { udid: "U" } }, BIN),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("refuses a symlink that escapes the allowed roots", async () => {
    const secret = join(homedir(), `probe-secret-${randomUUID()}.txt`);
    const link = join(homedir(), "Desktop", `probe-link-${randomUUID()}.txt`);
    writeFileSync(secret, "SECRET");
    symlinkSync(secret, link);

    try {
      await expect(
        runHostActionAsync({ action: "file.readBase64", params: { path: link } }, BIN),
      ).rejects.toBeInstanceOf(InvalidHostActionError);
    } finally {
      rmSync(link, { force: true });
      rmSync(secret, { force: true });
    }
  });

  // A file source is rendered into the preview stream, so it is confined like any other read.
  it("refuses a camera file source outside the allowed roots", async () => {
    await expect(
      runHostActionAsync(
        { action: "camera.switch", params: { source: "file", target: "/etc/passwd", udid: "U" } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("refuses coordinates that are not numbers", async () => {
    await expect(
      runHostActionAsync({ action: "location.set", params: { udid: "U", lat: null, lng: null } }, BIN),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("refuses an upload chunk that is empty or not base64", async () => {
    for (const data of ["", "not base64!!"]) {
      await expect(
        runHostActionAsync({ action: "upload.append", params: { uploadId: "a.bin", data } }, BIN),
      ).rejects.toBeInstanceOf(InvalidHostActionError);
    }
  });

  it("accepts a path inside an allowed root", async () => {
    const file = join(homedir(), "Desktop", `probe-ok-${randomUUID()}.txt`);
    writeFileSync(file, "hello");

    try {
      const result = await runHostActionAsync(
        { action: "file.readBase64", params: { path: file } },
        BIN,
      );
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(file, { force: true });
    }
  });

  // Both paths fail against a missing binary, so assert which program was actually spawned.
  it("runs a .ts entrypoint through bun rather than executing it directly", async () => {
    const viaBun = await runHostActionAsync(
      { action: "camera.listWebcams" },
      // Under the operator's home dir, so the reply would carry their path if it were not redacted.
      join(homedir(), "does-not-exist", "serve-sim.ts"),
    );
    const direct = await runHostActionAsync(
      { action: "camera.listWebcams" },
      "/does/not/exist/serve-sim",
    );

    // The runtime prints the absolute path it could not load; the reply keeps the reason, not the path.
    expect(viaBun.stderr).toContain("Module not found");
    expect(viaBun.stderr).not.toContain(homedir());
    expect(direct.stderr).toContain("ENOENT");
  });
});
