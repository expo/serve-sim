import { describe, expect, test } from "bun:test";

import { ACCESS_COOKIE } from "../session-auth";
import { simMiddleware } from "../middleware";

const TOKEN = "preview-token-xyz";
const ORIGIN = "http://192.168.1.20:34567";

function gated(requirePreviewToken: boolean) {
  const handler = simMiddleware({ basePath: "/", execToken: TOKEN, requirePreviewToken });
  return async (path: string, init?: RequestInit) => {
    const response = await handler(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }));
    if (!response) throw new Error(`Unhandled request: ${path}`);
    return response;
  };
}

describe("preview access on a non-loopback bind", () => {
  test("refuses /api, so the token cannot be fetched by whoever asks first", async () => {
    const response = await gated(true)("/api");

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(TOKEN);
  });

  test("refuses the preview page that carries the token in its config", async () => {
    expect((await gated(true)("/")).status).toBe(401);
  });

  test("serves /api to a caller that already holds the token", async () => {
    const response = await gated(true)("/api", { headers: { Authorization: `Bearer ${TOKEN}` } });

    expect(response.status).toBe(200);
  });

  test("trades a link token for a cookie and redirects it out of the URL", async () => {
    const response = await gated(true)(`/?token=${TOKEN}`);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toContain(ACCESS_COOKIE);
  });

  test("accepts the cookie it handed out", async () => {
    const response = await gated(true)("/api", {
      headers: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(TOKEN)}` },
    });

    expect(response.status).toBe(200);
  });

  test("leaves a loopback server open, where a prompt would buy nothing", async () => {
    expect((await gated(false)("/api")).status).toBe(200);
  });
});

describe("the rest of the surface on a non-loopback bind", () => {
  test("refuses to boot or shut down a simulator without the token", async () => {
    const request = gated(true);

    expect((await request("/grid/api/start", { method: "POST" })).status).toBe(401);
    expect((await request("/grid/api/shutdown", { method: "POST" })).status).toBe(401);
  });

  test("refuses to stream device metrics without the token", async () => {
    expect((await gated(true)("/metrics")).status).toBe(401);
  });

  test("accepts the cookie the browser already carries, so the UI keeps working", async () => {
    const cookie = { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(TOKEN)}` };

    expect((await gated(true)("/grid/api", { headers: cookie })).status).toBe(200);
  });

  test("leaves all of it open on loopback", async () => {
    expect((await gated(false)("/grid/api")).status).toBe(200);
  });
});
