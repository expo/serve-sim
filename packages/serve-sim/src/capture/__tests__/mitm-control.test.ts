import { describe, expect, test } from "bun:test";

import { startMitmControl } from "../mitm-control";
import { CaptureStore } from "../store";

describe("mitm control server", () => {
  test("authenticates the addon and records a completed exchange", async () => {
    const store = new CaptureStore(() => 10);
    const control = await startMitmControl({
      store,
      token: "secret",
      fields: ["header", "response-body"],
    });
    const post = (path: string, body: unknown, token = "secret") =>
      fetch(`http://127.0.0.1:${control.port}${path}?t=${token}`, {
        method: "POST",
        body: JSON.stringify(body),
      });

    try {
      expect((await post("/ready", {}, "wrong")).status).toBe(403);
      expect((await post("/ready", {})).status).toBe(200);
      await control.ready;
      expect((await post("/request", { id: "flow-1", method: "GET", url: "https://example.com" })).status).toBe(200);
      expect((await post("/response", {
        id: "flow-1",
        status: 200,
        durationMs: 12,
        req: { size: 4 },
        res: {
          size: 2,
          mime: "text/plain",
          headers: { authorization: "secret", "content-type": "text/plain" },
          body: "ok",
        },
      })).status).toBe(200);

      expect(store.list()[0]).toMatchObject({ status: 200, responseBytes: 2, durationMs: 12 });
      expect(store.body("r1")).toMatchObject({
        responseHeaders: { authorization: "[REDACTED]", "content-type": "text/plain" },
        responseBody: "ok",
      });

      await post("/request", { id: "flow-2", method: "GET", url: "https://example.com/image" });
      await post("/response", {
        id: "flow-2",
        status: 200,
        req: { size: 0 },
        res: { size: 4, mime: "image/png", base64: "//4AAQ==" },
      });
      expect(store.body("r2")).toMatchObject({
        responseBody: "//4AAQ==",
        responseBinary: true,
      });
    } finally {
      await new Promise<void>((resolve) => control.server.close(() => resolve()));
    }
  });
});
