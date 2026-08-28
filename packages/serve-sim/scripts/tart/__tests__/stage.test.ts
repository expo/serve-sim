import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadTartConfig } from "../guest";
import { resolveTestFiles } from "../stage";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tart-stage-"));
  tmpDirs.push(root);
  return root;
}

describe("tart stage", () => {
  test("defaults to pasteboard e2e files when they exist", () => {
    const root = tmpRoot();
    mkdirSync(join(root, "src", "__tests__"), { recursive: true });
    writeFileSync(join(root, "src", "__tests__", "pasteboard-inject.e2e.test.ts"), "");
    writeFileSync(join(root, "src", "__tests__", "pasteboard-endpoint.test.ts"), "");
    expect(resolveTestFiles(root, [])).toEqual([
      "src/__tests__/pasteboard-inject.e2e.test.ts",
      "src/__tests__/pasteboard-endpoint.test.ts",
    ]);
  });

  test("passes through explicit files", () => {
    expect(resolveTestFiles("/nope", ["src/__tests__/foo.test.ts"])).toEqual([
      "src/__tests__/foo.test.ts",
    ]);
  });

  test("returns no defaults when the pasteboard tests are missing", () => {
    const root = tmpRoot();
    expect(resolveTestFiles(root, [])).toEqual([]);
  });
});

describe("tart config", () => {
  test("resolves the serve-sim package as pkgDir", () => {
    const config = loadTartConfig();
    expect(config.pkgDir.endsWith("packages/serve-sim")).toBe(true);
    expect(config.vm).toBe(process.env.TART_VM ?? "tahoe-xcode");
  });

  test("rejects a TART_USER that is not a unix name", () => {
    const previous = process.env.TART_USER;
    process.env.TART_USER = "expo; rm -rf /";
    try {
      expect(() => loadTartConfig()).toThrow(/invalid TART_USER/);
    } finally {
      if (previous === undefined) delete process.env.TART_USER;
      else process.env.TART_USER = previous;
    }
  });
});
