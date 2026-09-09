import { describe, expect, it } from "bun:test";

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { open } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";

import { InvalidHostActionError, runHostActionAsync } from "../host-actions";

const BIN = "true";
const UDID = "404F2659-7202-4450-8465-912BD2AB744B";

describe("what a preview link may spend on the host", () => {
  it("refuses an upload chunk larger than the cap", async () => {
    const oversized = "A".repeat(5 * 1024 * 1024);
    await expect(
      runHostActionAsync(
        { action: "upload.append", params: { uploadId: "big.ipa", data: oversized } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("accepts a chunk inside the cap", async () => {
    const result = await runHostActionAsync(
      {
        action: "upload.append",
        params: { uploadId: "small.bin", data: btoa("hello"), first: true },
      },
      BIN,
    );
    try {
      expect(result.exitCode).toBe(0);
      expect(readFileSync(result.stdout.trim(), "utf8")).toBe("hello");
    } finally {
      await runHostActionAsync({ action: "upload.remove", params: { uploadId: "small.bin" } }, BIN);
    }
  });

  // argv is not line-delimited, so a newline cannot split an argument, but a NUL makes execFile
  // throw a TypeError rather than a validation error, and the caller gets an opaque "action failed".
  it.each([
    ["a newline", "cam\nera"],
    ["a NUL byte", "cam\u0000era"],
    ["a carriage return", "cam\rera"],
  ])("refuses an argument carrying %s", async (_label, target) => {
    await expect(
      runHostActionAsync(
        { action: "camera.switch", params: { udid: UDID, source: "webcam", target } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });
  // Any other name would slip the Desktop ceiling, which counts serve-sim's own screenshots, and
  // simctl overwrites silently, so it would also replace an arbitrary file on the Desktop.
  it.each(["Thesis.docx", "notes.txt", "shot.png", "serve-sim-screenshot-x.jpg"])(
    "refuses to write a screenshot named %s",
    async (fileName) => {
      await expect(
        runHostActionAsync({ action: "screenshot.capture", params: { udid: UDID, fileName } }, BIN),
      ).rejects.toBeInstanceOf(InvalidHostActionError);
    },
  );
  // Argument-typed fields reach the serve-sim CLI as positionals, so a leading dash would arrive
  // as a flag. Device-typed fields are covered elsewhere; this is the Argument guard.
  it("refuses a webcam name that would be read as a flag", async () => {
    await expect(
      runHostActionAsync(
        { action: "camera.switch", params: { udid: UDID, source: "webcam", target: "--help" } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });
  // The ceiling is a read-then-write. Unserialized, every concurrent chunk reads the same pre-write
  // total, all pass, and the staging area sails past 2GB. A sparse filler puts the directory one
  // chunk under the limit without consuming disk, so the overshoot is visible in the accept count.
  it("does not let parallel chunks overshoot the staging ceiling", async () => {
    const MAX_UPLOAD_DIR_BYTES = 2 * 1024 * 1024 * 1024;
    const chunk = 1024;
    const dir = join(tmpdir(), "serve-sim-uploads");
    const filler = join(dir, "zz-toctou-filler.bin");
    const ids = Array.from({ length: 8 }, (_unused, i) => `zz-toctou-${i}.bin`);

    mkdirSync(dir, { recursive: true });
    let existing = 0;
    for (const entry of readdirSync(dir)) {
      try {
        existing += statSync(join(dir, entry)).size;
      } catch {}
    }

    const handle = await open(filler, "w");
    await handle.truncate(MAX_UPLOAD_DIR_BYTES - existing - 2 * chunk);
    await handle.close();

    try {
      const data = btoa("C".repeat(chunk));
      const results = await Promise.all(
        ids.map((uploadId) =>
          runHostActionAsync(
            { action: "upload.append", params: { uploadId, data, first: true } },
            BIN,
          ),
        ),
      );

      expect(results.filter((r) => r.exitCode === 0).length).toBeLessThanOrEqual(2);
      expect(results.some((r) => r.stderr.includes("staging area is full"))).toBe(true);
    } finally {
      rmSync(filler, { force: true });
      for (const uploadId of ids) rmSync(join(dir, uploadId), { force: true });
    }
  });
  // ~/Desktop, ~/Documents and ~/Downloads are TCC-protected. Canonicalizing a path inside one
  // opens it, and on a host with nobody to answer the consent prompt that open blocks in the
  // kernel forever and cannot be timed out, so these are refused before the filesystem is touched.
  //
  // These assert the refusal, which is the contract. They cannot prove the refusal happens without
  // the syscall: on a machine whose consent is already granted the open returns either way. Only a
  // headless host separates the two, so CI is what guards the ordering — before this, that ordering
  // was wrong and CI hung here for two hours.
  //
  // The screenshot name matters most: it is the one shape this server writes there, so it is the
  // one that would tempt someone to allow the directory back in.
  it.each([
    ["Desktop", "Thesis.docx"],
    ["Desktop", "id_rsa"],
    ["Desktop", "serve-sim-screenshot-x.png"],
    ["Documents", "notes.txt"],
    ["Downloads", "installer.dmg"],
  ])("refuses to read ~/%s/%s", async (dir, name) => {
    await expect(
      runHostActionAsync(
        { action: "file.readBase64", params: { path: join(homedir(), dir, name) } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it.each(["Desktop", "Documents", "Downloads"])("refuses ~/%s itself", async (dir) => {
    await expect(
      runHostActionAsync({ action: "file.readBase64", params: { path: join(homedir(), dir) } }, BIN),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  // The check runs on the resolved path, so a traversal that lands in a protected directory is
  // caught even though the string it arrived as pointed somewhere allowed.
  it("refuses a traversal that resolves into a protected directory", async () => {
    const escape = join(tmpdir(), "serve-sim-uploads", "..", "..", "..", "..");
    await expect(
      runHostActionAsync(
        {
          action: "file.readBase64",
          params: { path: join(escape, homedir(), "Desktop", "serve-sim-screenshot-x.png") },
        },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });
  // simctl wedges on a busy simulator and never returns; without a deadline the child holds its
  // in-flight slot for the life of the process and eight of them silence the channel for good.
  it("gives up on a child that never exits", async () => {
    const shimDir = mkdtempSync(join(tmpdir(), "serve-sim-hang-"));
    try {
      const shim = join(shimDir, "xcrun");
      writeFileSync(shim, "#!/bin/sh\nsleep 600\n");
      chmodSync(shim, 0o755);
      const originalPath = process.env.PATH;
      const originalTimeout = process.env.SERVE_SIM_ACTION_TIMEOUT_MS;
      process.env.PATH = `${shimDir}:${originalPath ?? ""}`;
      // The shipped default is 2 minutes; the deadline is read per call so a test can shorten it.
      process.env.SERVE_SIM_ACTION_TIMEOUT_MS = "3000";
      try {
        const started = Date.now();
        const result = await runHostActionAsync(
          { action: "appearance.get", params: { udid: UDID } },
          BIN,
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("did not answer within");
        expect(Date.now() - started).toBeLessThan(15_000);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        if (originalTimeout === undefined) delete process.env.SERVE_SIM_ACTION_TIMEOUT_MS;
        else process.env.SERVE_SIM_ACTION_TIMEOUT_MS = originalTimeout;
      }
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  }, 40_000);
});