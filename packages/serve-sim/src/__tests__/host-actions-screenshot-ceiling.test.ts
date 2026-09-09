import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runHostActionAsync } from "../host-actions";

// The ceiling counts serve-sim's own staging directory, so this needs no redirected homedir and
// runs in-process. Shims keep a real simulator and the operator's real Desktop out of it.
const SHIM = `#!/bin/sh\nexit 0\n`;
const STAGING = join(tmpdir(), "serve-sim-screenshots");
const FILLER_PREFIX = "serve-sim-screenshot-ceil-";
const params = {
  udid: "404F2659-7202-4450-8465-912BD2AB744B",
  fileName: "serve-sim-screenshot-next.png",
};

let shimDir: string;
let originalPath: string | undefined;

beforeAll(() => {
  shimDir = mkdtempSync(join(tmpdir(), "serve-sim-ceiling-"));
  for (const name of ["xcrun", "cp"]) {
    const p = join(shimDir, name);
    writeFileSync(p, SHIM);
    chmodSync(p, 0o755);
  }
  originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
  mkdirSync(STAGING, { recursive: true });
});

afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(shimDir, { recursive: true, force: true });
  clearFillers();
  rmSync(join(STAGING, params.fileName), { force: true });
});

/** Only the fillers, so a capture staged by another file keeps its own ceiling arithmetic. */
function clearFillers(): void {
  for (const entry of readdirSync(STAGING)) {
    if (entry.startsWith(FILLER_PREFIX)) rmSync(join(STAGING, entry), { force: true });
  }
}

function stage(screenshots: number, others = 0): void {
  clearFillers();
  for (let i = 0; i < screenshots; i += 1) {
    writeFileSync(join(STAGING, `${FILLER_PREFIX}${i}.png`), "");
  }
  for (let i = 0; i < others; i += 1) {
    writeFileSync(join(STAGING, `holiday-${i}.png`), "");
  }
}

const capture = (): ReturnType<typeof runHostActionAsync> =>
  runHostActionAsync({ action: "screenshot.capture", params }, "true");

describe("screenshot ceiling", () => {
  it("refuses once the staging area already holds the ceiling", async () => {
    stage(200);
    const result = await capture();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("screenshots are still staged");
  });

  it("keeps capturing one under the ceiling", async () => {
    stage(198);
    expect((await capture()).stderr).not.toContain("screenshots are still staged");
  });

  it("does not count unrelated staged files toward the ceiling", async () => {
    stage(0, 300);
    expect((await capture()).stderr).not.toContain("screenshots are still staged");
    for (let i = 0; i < 300; i += 1) rmSync(join(STAGING, `holiday-${i}.png`), { force: true });
  });
});
