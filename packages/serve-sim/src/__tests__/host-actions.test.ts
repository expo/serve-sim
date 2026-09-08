import { describe, expect, it } from "bun:test";

import { rmSync, symlinkSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { homedir, tmpdir } from "os";
import { join } from "path";

import { appendFileSync, writeSync } from "fs";

import { InvalidHostActionError, runHostActionAsync } from "../host-actions";

const mark = (msg: string) => {
  try {
    writeSync(2, `[mark] ${msg}\n`);
    appendFileSync("/tmp/serve-sim-trace.log", `[mark] ${msg}\n`);
  } catch {}
};

// `true` ignores its arguments and exits 0, so these assert validation without running simctl.
const BIN = "true";

describe("runHostActionAsync validation", () => {
  it("refuses an unknown action", async () => {
    mark("ENTER refuses an unknown action");
    await expect(runHostActionAsync({ action: "shell.run" }, BIN)).rejects.toBeInstanceOf(
      InvalidHostActionError,
    );
  });

  it("refuses a missing action", async () => {
    mark("ENTER refuses a missing action");
    await expect(runHostActionAsync({}, BIN)).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("refuses a required param that is missing or empty", async () => {
    mark("ENTER refuses a required param that is missing or empty");
    await expect(runHostActionAsync({ action: "appearance.get" }, BIN)).rejects.toBeInstanceOf(
      InvalidHostActionError,
    );
    await expect(
      runHostActionAsync({ action: "appearance.get", params: { udid: "" } }, BIN),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("refuses a value outside the allowed set", async () => {
    mark("ENTER refuses a value outside the allowed set");
    await expect(
      runHostActionAsync(
        { action: "appearance.set", params: { udid: "U", value: "rm -rf /" } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("rejects a bundle id carrying shell metacharacters", async () => {
    mark("ENTER rejects a bundle id carrying shell metacharacters");
    await expect(
      runHostActionAsync(
        { action: "permissions.resetAll", params: { bundleId: "a; touch /tmp/pwned", udid: "U" } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("rejects a path outside the paths the preview may read", async () => {
    mark("ENTER rejects a path outside the paths the preview may read");
    mark("test6 start");
    await expect(
      runHostActionAsync({ action: "file.readBase64", params: { path: "/etc/passwd" } }, BIN),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
    mark("test6 passwd assertion done");
    mark("test6 calling homedir in test body");
    const home = homedir();
    mark(`test6 homedir returned :: ${home}`);
    await expect(
      runHostActionAsync(
        { action: "file.readBase64", params: { path: `${home}/Desktop/../../.ssh/id_rsa` } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
    mark("test6 ssh assertion done");
  });

  it("rejects an argument that would be read as a flag", async () => {
    mark("ENTER rejects an argument that would be read as a flag");
    await expect(
      runHostActionAsync({ action: "server.detach", params: { udid: "--host=0.0.0.0" } }, BIN),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("passes params through as literal arguments to a real spawn", async () => {
    mark("ENTER passes params through as literal arguments to a real spawn");
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
    mark("ENTER rejects an uploadId that tries to traverse out of the upload");
    for (const uploadId of ["../../evil", "a/b", ".hidden"]) {
      await expect(
        runHostActionAsync({ action: "upload.append", params: { uploadId, data: "aGk=" } }, BIN),
      ).rejects.toBeInstanceOf(InvalidHostActionError);
    }
  });

  it("rejects an install with neither an upload nor a path", async () => {
    mark("ENTER rejects an install with neither an upload nor a path");
    await expect(
      runHostActionAsync({ action: "app.install", params: { udid: "U" } }, BIN),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("refuses a symlink that escapes the allowed roots", async () => {
    mark("ENTER refuses a symlink that escapes the allowed roots");
    const secret = join(homedir(), `probe-secret-${randomUUID()}.txt`);
    const link = join(tmpdir(), "serve-sim-uploads", `probe-link-${randomUUID()}.txt`);
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
    mark("ENTER refuses a camera file source outside the allowed roots");
    await expect(
      runHostActionAsync(
        { action: "camera.switch", params: { source: "file", target: "/etc/passwd", udid: "U" } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("refuses coordinates that are not numbers", async () => {
    mark("ENTER refuses coordinates that are not numbers");
    await expect(
      runHostActionAsync({ action: "location.set", params: { udid: "U", lat: null, lng: null } }, BIN),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("refuses an upload chunk that is empty or not base64", async () => {
    mark("ENTER refuses an upload chunk that is empty or not base64");
    for (const data of ["", "not base64!!"]) {
      await expect(
        runHostActionAsync({ action: "upload.append", params: { uploadId: "a.bin", data } }, BIN),
      ).rejects.toBeInstanceOf(InvalidHostActionError);
    }
  });

  it("accepts a path inside an allowed root", async () => {
    mark("ENTER accepts a path inside an allowed root");
    const file = join(tmpdir(), "serve-sim-uploads", `probe-ok-${randomUUID()}.txt`);
    writeFileSync(file, "hello");

    try {
      const result = await runHostActionAsync(
        { action: "file.readBase64", params: { path: file } },
        BIN,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(btoa("hello"));
    } finally {
      rmSync(file, { force: true });
    }
  });

  // Both paths fail against a missing binary, so assert which program was actually spawned.
  it("runs a .ts entrypoint through bun rather than executing it directly", async () => {
    mark("ENTER runs a .ts entrypoint through bun rather than executing it d");
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
