import { describe, expect, it } from "bun:test";

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
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
  // The Desktop is the operator's own space; the only file there that belongs to this server is a
  // screenshot it wrote, so reads are limited to the same names writes are.
  it.each(["Thesis.docx", "notes.txt", "id_rsa", "screenshot.png"])(
    "refuses to read %s off the Desktop",
    async (name) => {
      await expect(
        runHostActionAsync(
          { action: "file.readBase64", params: { path: join(homedir(), "Desktop", name) } },
          BIN,
        ),
      ).rejects.toBeInstanceOf(InvalidHostActionError);
    },
  );
});