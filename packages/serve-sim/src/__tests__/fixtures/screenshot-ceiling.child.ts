import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import { join } from "path";

// Run by host-actions-screenshot-ceiling.test.ts in a child process. bun's os.homedir() reads the
// passwd entry rather than $HOME, so the only way to reach the ceiling is to redirect the module
// before host-actions binds it — and that binding survives mock.restore, which is why this file is
// kept out of the main run rather than mocking in-process.
const home = mkdtempSync(join(os.tmpdir(), "serve-sim-ceiling-"));
const desktop = join(home, "Desktop");

let runHostActionAsync: typeof import("../../host-actions").runHostActionAsync;

beforeAll(async () => {
  mkdirSync(desktop);
  mock.module("os", () => ({ ...os, default: { ...os, homedir: () => home }, homedir: () => home }));
  ({ runHostActionAsync } = await import("../../host-actions"));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function fillDesktop(screenshots: number, others = 0): void {
  rmSync(desktop, { recursive: true, force: true });
  mkdirSync(desktop);
  for (let i = 0; i < screenshots; i += 1) {
    writeFileSync(join(desktop, `serve-sim-screenshot-${i}.png`), "");
  }
  for (let i = 0; i < others; i += 1) {
    writeFileSync(join(desktop, `holiday-${i}.png`), "");
  }
}

describe("screenshot ceiling", () => {
  const params = { udid: "404F2659-7202-4450-8465-912BD2AB744B", fileName: "serve-sim-screenshot-next.png" };
  const capture = () => runHostActionAsync({ action: "screenshot.capture", params }, "true");

  it("refuses once the Desktop already holds the ceiling", async () => {
    fillDesktop(200);
    const result = await capture();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Too many serve-sim screenshots");
  });

  it("keeps capturing one under the ceiling", async () => {
    fillDesktop(199);
    expect((await capture()).stderr).not.toContain("Too many serve-sim screenshots");
  });

  it("does not count unrelated Desktop files toward the ceiling", async () => {
    fillDesktop(0, 300);
    expect((await capture()).stderr).not.toContain("Too many serve-sim screenshots");
  });
});
