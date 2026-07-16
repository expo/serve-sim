import { describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { simMiddleware } from "../middleware";

// GET {base}/api/screenshot — still-PNG capture via `simctl io <udid> screenshot`.
// Consumed by the Expo Device Hub dashboard's save-screenshot action (the
// serve-sim web UI shells out over exec-ws instead). Restored after the
// fetch-style middleware rewrite (bff5212) dropped the route.

const middleware = simMiddleware({ basePath: "/preview" });

function firstBootedIosSim(): string | null {
  try {
    const out = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
    const data = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const [runtime, devices] of Object.entries(data.devices)) {
      if (!runtime.includes("iOS")) continue;
      for (const device of devices) {
        if (device.state === "Booted") return device.udid;
      }
    }
  } catch {}
  return null;
}

describe("GET /api/screenshot", () => {
  test("rejects non-GET/POST methods", async () => {
    const res = await middleware(
      new Request("http://localhost:3200/preview/api/screenshot", { method: "PUT" }),
    );
    expect(res?.status).toBe(405);
  });

  test("rejects a malformed device udid without shelling out", async () => {
    const res = await middleware(
      new Request("http://localhost:3200/preview/api/screenshot?device=not-a-udid"),
    );
    expect(res?.status).toBe(400);
    const body = (await res!.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("No booted simulator");
  });
});

const bootedUdid = firstBootedIosSim();
const describeWithSim = bootedUdid ? describe : describe.skip;

describeWithSim(`GET /api/screenshot (booted sim ${bootedUdid ?? "<skipped>"})`, () => {
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  test("returns a PNG for an explicit device", async () => {
    const res = await middleware(
      new Request(
        `http://localhost:3200/preview/api/screenshot?device=${encodeURIComponent(bootedUdid!)}`,
      ),
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("image/png");
    expect(res?.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await res!.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual(PNG_MAGIC);
  }, 45_000);

  test("falls back to a booted simulator when no device is given", async () => {
    const res = await middleware(
      new Request("http://localhost:3200/preview/api/screenshot"),
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res!.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual(PNG_MAGIC);
  }, 45_000);
});
