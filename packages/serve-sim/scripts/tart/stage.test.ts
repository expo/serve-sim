import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveTestFiles } from "./stage";
import { loadTartConfig } from "./guest";

describe("tart stage", () => {
  test("defaults to pasteboard e2e files when they exist", () => {
    const root = mkdtempSync(join(tmpdir(), "tart-stage-"));
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
    const root = mkdtempSync(join(tmpdir(), "tart-stage-empty-"));
    expect(resolveTestFiles(root, [])).toEqual([]);
  });
});

describe("tart config", () => {
  test("resolves the serve-sim package as pkgDir", () => {
    const config = loadTartConfig();
    expect(config.pkgDir.endsWith("packages/serve-sim")).toBe(true);
    expect(config.vm).toBe(process.env.TART_VM ?? "tahoe-xcode");
  });
});
