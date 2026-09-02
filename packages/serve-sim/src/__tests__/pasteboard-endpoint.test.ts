import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { simMiddleware } from "../middleware";
import { pbcopyCommand } from "../client/utils/sim-clipboard";
import {
  ensureFixtureInstalled,
  firstBootedIosSim,
  FIXTURE_BUNDLE,
  openAppForPasteboard,
  PASTEBOARD_TEST_APPS,
  pasteboardFixture,
  pasteboardTool,
  SAFARI_BUNDLE,
} from "./pasteboard-sim";

const TEST_TOKEN = "test-token";
const middleware = simMiddleware({ basePath: "/preview", execToken: TEST_TOKEN });

function pasteboardRequest(query = "", method = "POST"): Request {
  return new Request(`http://localhost:3200/preview/api/pasteboard${query}`, {
    method,
    headers: { Authorization: `Bearer ${TEST_TOKEN}` },
  });
}

describe("POST /api/pasteboard", () => {
  test("rejects non-POST methods", async () => {
    const res = await middleware(pasteboardRequest("", "GET"));
    expect(res?.status).toBe(405);
    expect(res?.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("requires the preview token", async () => {
    const res = await middleware(
      new Request("http://localhost:3200/preview/api/pasteboard", { method: "POST" }),
    );
    expect(res?.status).toBe(401);
    expect(res?.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("rejects a malformed device udid", async () => {
    const res = await middleware(pasteboardRequest("?device=not-a-udid"));
    expect(res?.status).toBe(400);
    expect(res?.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await res!.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Invalid simulator device ID");
  });

  test("returns JSON when the pasteboard read fails", async () => {
    const unavailableUdid = "00000000-0000-0000-0000-000000000000";
    const res = await middleware(pasteboardRequest(`?device=${unavailableUdid}`));
    expect(res?.status).toBe(500);
    expect(res?.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await res!.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });
});

const bootedUdid = firstBootedIosSim();
const describeWithSim = bootedUdid && pasteboardTool ? describe : describe.skip;

for (const app of PASTEBOARD_TEST_APPS) {
  const run = "requireFixture" in app && !pasteboardFixture ? describe.skip : describeWithSim;
  run(`POST /api/pasteboard from ${app.label} (${bootedUdid ?? "<skipped>"})`, () => {
    let session: { unsubscribe: () => void } | undefined;

    beforeAll(async () => {
      if (app.bundleId === FIXTURE_BUNDLE) ensureFixtureInstalled(bootedUdid!);
      session = await openAppForPasteboard(bootedUdid!, app.bundleId);
    }, 60_000);

    afterAll(() => {
      session?.unsubscribe();
    });

    test("returns JSON text for an explicit device", async () => {
      const probe = `serve-sim-pasteboard-probe-${app.label.replace(/\s+/g, "-")}`;
      execSync(pbcopyCommand(bootedUdid!, probe, pasteboardTool!));
      const res = await middleware(
        pasteboardRequest(`?device=${encodeURIComponent(bootedUdid!)}`),
      );
      expect(res?.status).toBe(200);
      expect(res?.headers.get("content-type")).toBe("application/json");
      expect(res?.headers.get("access-control-allow-origin")).toBeNull();
      const body = (await res!.json()) as { ok: boolean; text: string };
      expect(body.ok).toBe(true);
      expect(body.text).toBe(probe);
    }, 45_000);

    if (app.bundleId === SAFARI_BUNDLE) {
      test("falls back to a booted simulator when no device is given", async () => {
        const res = await middleware(pasteboardRequest());
        expect(res?.status).toBe(200);
        expect(res?.headers.get("content-type")).toBe("application/json");
        const body = (await res!.json()) as { ok: boolean; text: string };
        expect(body.ok).toBe(true);
        expect(typeof body.text).toBe("string");
      }, 45_000);
    }
  });
}
