import { afterAll, beforeAll, expect, test } from "bun:test";

import { simMiddleware } from "../middleware";
import { accessCookieName } from "../session-auth";
import { servePreview, type PreviewServer } from "../runtime";
import { freePortAsync } from "./helpers";

let server: PreviewServer;
let url: string;

beforeAll(async () => {
  const port = await freePortAsync();
  server = await servePreview({
    port,
    host: "127.0.0.1",
    middleware: simMiddleware({
      basePath: "/",
      device: "404F2659-7202-4450-8465-912BD2AB744B",
      execToken: "recording-session-token",
      requirePreviewToken: false,
    }),
  });
  url = `http://127.0.0.1:${port}/helper/404F2659-7202-4450-8465-912BD2AB744B/recording/video`;
});

afterAll(() => server?.stop(true));

test("recording start and stop require the session token even when the preview is open", async () => {
  const start = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start: true, output: "/tmp/recording" }),
  });
  expect(start.status).toBe(401);

  const stop = await fetch(url, { method: "DELETE" });
  expect(stop.status).toBe(401);
});


test("recording control rejects a preview cookie without the bearer token", async () => {
  const token = "recording-session-token";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Cookie: `${accessCookieName(token)}=${token}`,
      Origin: new URL(url).origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ start: true, output: "/tmp/recording", recordingId: "test" }),
  });
  expect(response.status).toBe(401);
});


test("recording preflight permits lease renewal and stop", async () => {
  const response = await fetch(url, {
    method: "OPTIONS",
    headers: {
      Origin: "http://127.0.0.1",
      "Access-Control-Request-Method": "DELETE",
      "Access-Control-Request-Headers": "Authorization, x-recording-id",
    },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
  expect(response.headers.get("access-control-allow-methods")).toContain("DELETE");
  expect(response.headers.get("access-control-allow-headers")).toContain("x-recording-id");
});
