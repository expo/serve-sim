import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "child_process";
import { pbcopyCommand } from "../client/utils/sim-clipboard";
import { readSimPasteboard } from "../sim-pasteboard";
import {
  armClipboardForAllApps,
  askAppPasteboard,
  launchTrackedApp,
  ensureFixtureInstalled,
  firstBootedIosSim,
  FIXTURE_BUNDLE,
  isHeadlessPasteboard,
  mappedDylibCount,
  openAppForPasteboard,
  PASTEBOARD_TEST_APPS,
  pasteboardDylib,
  pasteboardFixture,
  pasteboardTool,
  runningPid,
  terminatePasteboardApps,
  withSkipPbpaste,
} from "./pasteboard-sim";

const udid = firstBootedIosSim();
const describeIfInject = udid && pasteboardTool && pasteboardDylib ? describe : describe.skip;

describeIfInject(`injected pasteboard read (booted sim ${udid ?? "<skipped>"})`, () => {
  test.skipIf(!isHeadlessPasteboard())("simctl pbpaste fails without a GUI login session", () => {
    expect(() =>
      execFileSync("xcrun", ["simctl", "pbpaste", udid!], { stdio: "pipe" }),
    ).toThrow();
  });
});

for (const app of PASTEBOARD_TEST_APPS) {
  const run = "requireFixture" in app && !pasteboardFixture ? describe.skip : describeIfInject;
  run(`injected pasteboard read in ${app.label} (${udid ?? "<skipped>"})`, () => {
    let session: { unsubscribe: () => void; pid: number } | undefined;

    beforeAll(async () => {
      if (app.bundleId === FIXTURE_BUNDLE) ensureFixtureInstalled(udid!);
      session = await openAppForPasteboard(udid!, app.bundleId);
    }, 60_000);

    afterAll(() => {
      session?.unsubscribe();
    });

    // vmmap refuses to examine Safari, so this runs on our own app. The
    // answer assertions below prove the load either way; this one proves it
    // without trusting the protocol.
    test.skipIf(app.bundleId !== FIXTURE_BUNDLE)("the reader is mapped into the app", () => {
      expect(
        mappedDylibCount(udid!, session!.pid, "libSimPasteboardReader.dylib"),
      ).toBeGreaterThan(0);
    }, 20_000);

    test("the dylib answers a request in the app container", async () => {
      const probe = `serve-sim-protocol-probe-${app.label.replace(/\s+/g, "-")}`;
      execSync(pbcopyCommand(udid!, probe, pasteboardTool!));
      expect(await askAppPasteboard(udid!, app.bundleId)).toBe(probe);
    }, 15_000);

    test("readSimPasteboard returns writer text via pbpaste or inject", async () => {
      const probe = `serve-sim-product-read-${app.label.replace(/\s+/g, "-")}`;
      execSync(pbcopyCommand(udid!, probe, pasteboardTool!));
      expect(await readSimPasteboard(udid!)).toBe(probe);
    }, 20_000);

    test("reads unicode through the dylib when pbpaste is skipped", async () => {
      const probe = `café 🎉 email+tag@x.com 日本語 ${app.label}`;
      execSync(pbcopyCommand(udid!, probe, pasteboardTool!));
      expect(await withSkipPbpaste(() => readSimPasteboard(udid!))).toBe(probe);
    }, 20_000);
  });
}

// The point of a wildcard: an app the session never named still answers, so
// Copy does not have to terminate and relaunch it out from under the user.
const describeWildcard = udid && pasteboardTool && pasteboardDylib && pasteboardFixture
  ? describe
  : describe.skip;

describeWildcard(`clipboard armed for every app (${udid ?? "<skipped>"})`, () => {
  afterAll(() => {
    terminatePasteboardApps(udid!);
  });

  test("an app launched after arming answers without being relaunched", async () => {
    ensureFixtureInstalled(udid!);
    await armClipboardForAllApps(udid!);

    const session = await launchTrackedApp(udid!, FIXTURE_BUNDLE);
    const before = runningPid(udid!, FIXTURE_BUNDLE);
    expect(before).not.toBeNull();

    const probe = "serve-sim-wildcard-probe";
    execSync(pbcopyCommand(udid!, probe, pasteboardTool!));
    expect(await withSkipPbpaste(() => readSimPasteboard(udid!))).toBe(probe);

    // Same pid means the read went to the running process, not a fresh one.
    expect(runningPid(udid!, FIXTURE_BUNDLE)).toBe(before);
    session.unsubscribe();
  }, 60_000);
});

describeIfInject(`injected pasteboard read with SpringBoard frontmost (${udid ?? "<skipped>"})`, () => {
  test("tells you to open the app you copied from", async () => {
    terminatePasteboardApps(udid!);
    await Bun.sleep(1000);
    await expect(withSkipPbpaste(() => readSimPasteboard(udid!))).rejects.toThrow(
      /Open the app you copied from/,
    );
  }, 20_000);
});
