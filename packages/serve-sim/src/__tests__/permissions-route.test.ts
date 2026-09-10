import { describe, expect, test } from "bun:test";
import { connectToFetch } from "../connect-to-fetch";
import { createPermissionsHandler, type PermissionsRouteDeps } from "../permissions-route";
import type { PermissionStatus } from "../permissions";

const UDID = "0A73225E-069F-4A97-A481-00E701EDC9AA";
const ORIGIN = "http://127.0.0.1:3200";

function harness(states: Record<string, PermissionStatus["state"]> = {}) {
  const applied: unknown[][] = [];
  const deps: PermissionsRouteDeps = {
    list: (udid, bundleId) =>
      Object.entries(states).map(([id, state]) => ({ id, state, udid, bundleId })) as PermissionStatus[],
    apply: (...args) => {
      applied.push(args);
    },
  };
  const handle = createPermissionsHandler(deps);
  const request = (udid: string | null, path: string, init?: RequestInit) => {
    const url = new URL(`${ORIGIN}${path}`);
    return connectToFetch(
      (req, res) => handle(req, res, udid, url.searchParams),
      new Request(url, init),
    );
  };
  return { applied, request };
}

describe("permissions route", () => {
  test("lists one app's permissions for a simulator", async () => {
    const { request } = harness({ camera: "granted" });
    const response = await request(UDID, "/permissions?bundleId=com.example.app");
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      ok: true,
      bundleId: "com.example.app",
      permissions: [{ id: "camera", state: "granted", udid: UDID, bundleId: "com.example.app" }],
    });
  });

  test("rejects a missing device, an invalid bundle id, and other methods", async () => {
    const { request } = harness();
    expect((await request(null, "/permissions?bundleId=com.example.app"))?.status).toBe(400);
    expect((await request(UDID, "/permissions?bundleId=bad%20id"))?.status).toBe(400);
    expect((await request(UDID, "/permissions", { method: "DELETE" }))?.status).toBe(405);
  });

  test("applies a change and replies with the fresh list", async () => {
    const { applied, request } = harness({ camera: "denied" });
    const response = await request(UDID, "/permissions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ bundleId: "com.example.app", id: "camera", action: "revoke" }),
    });
    expect(response?.status).toBe(200);
    expect(applied).toEqual([[UDID, "com.example.app", "camera", "revoke"]]);
    const body = (await response?.json()) as { permissions: PermissionStatus[] };
    expect(body.permissions[0]).toMatchObject({ id: "camera", state: "denied" });
  });

  test("accepts reset all and rejects grant all", async () => {
    const { applied, request } = harness();
    const post = (payload: unknown) =>
      request(UDID, "/permissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    expect((await post({ bundleId: "com.example.app", id: "all", action: "reset" }))?.status).toBe(200);
    expect((await post({ bundleId: "com.example.app", id: "all", action: "grant" }))?.status).toBe(400);
    expect((await post({ bundleId: "com.example.app", id: "teleport", action: "grant" }))?.status).toBe(400);
    expect((await post({ bundleId: "com.example.app", id: "camera", action: "toggle" }))?.status).toBe(400);
    expect(applied).toEqual([[UDID, "com.example.app", "all", "reset"]]);
  });

  test("blocks non-JSON and cross-origin writes", async () => {
    const { applied, request } = harness();
    const form = await request(UDID, "/permissions", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(form?.status).toBe(415);
    const cross = await request(UDID, "/permissions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ bundleId: "com.example.app", id: "camera", action: "grant" }),
    });
    expect(cross?.status).toBe(403);
    expect(applied).toEqual([]);
  });

  test("surfaces a writer failure as 500", async () => {
    const handle = createPermissionsHandler({
      list: () => [],
      apply: () => {
        throw new Error("TCC.db not found");
      },
    });
    const url = new URL(`${ORIGIN}/permissions`);
    const response = await connectToFetch(
      (req, res) => handle(req, res, UDID, url.searchParams),
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundleId: "com.example.app", id: "camera", action: "grant" }),
      }),
    );
    expect(response?.status).toBe(500);
    expect(await response?.json()).toEqual({ ok: false, error: "TCC.db not found" });
  });
});
