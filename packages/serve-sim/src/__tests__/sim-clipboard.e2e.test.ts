import { describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "child_process";
import { pbcopyCommand } from "../client/utils/sim-clipboard";
import { firstBootedIosSim, isHeadlessPasteboard, pasteboardTool as tool } from "./pasteboard-sim";

const udid = firstBootedIosSim();

const skipOnCi = !!process.env.CI && process.env.SERVE_SIM_CLIPBOARD_E2E !== "1";
if (skipOnCi) {
  console.warn(
    "[sim-clipboard.e2e] skipping on CI: simulator pasteboard round-trip is unreliable on shared runners (set SERVE_SIM_CLIPBOARD_E2E=1 to force)",
  );
}

const describeIfSim = udid && tool && !skipOnCi && !isHeadlessPasteboard() ? describe : describe.skip;

describeIfSim(`simctl pasteboard round-trip (booted sim ${udid ?? "<skipped>"})`, () => {
  test("writer and pbpaste round-trip unicode", () => {
    const text = "café 🎉 email+tag@x.com — 日本語";
    execSync(pbcopyCommand(udid!, text, tool!), { env: { ...process.env, LANG: "C", LC_ALL: "C" } });
    const got = execFileSync("xcrun", ["simctl", "pbpaste", udid!], {
      encoding: "utf-8",
      env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
    });
    expect(got).toBe(text);
  });
});
