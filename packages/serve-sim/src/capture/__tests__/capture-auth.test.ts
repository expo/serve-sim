import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { simMiddleware } from "../../middleware";
import { useTempStateDir } from "../../__tests__/helpers";

const TOKEN = "capture-token-xyz";

async function withMiddleware(
  fn: (origin: string, request: (path: string, init?: RequestInit) => Promise<Response>) => Promise<void>,
): Promise<void> {
  const handler = simMiddleware({ basePath: "/", execToken: TOKEN });
  const origin = "http://127.0.0.1:34567";
  const request = async (path: string, init?: RequestInit) => {
    const response = await handler(new Request(`${origin}${path}`, init));
    if (!response) throw new Error(`Unhandled request: ${path}`);
    return response;
  };
  await fn(origin, request);
}

describe("network-capture auth", () => {
  let stateDir: ReturnType<typeof useTempStateDir>;
  beforeAll(() => {
    stateDir = useTempStateDir();
  });
  afterAll(() => {
    stateDir.restore();
  });

  test("rejects unauthenticated SSE", async () => {
    await withMiddleware(async (_origin, request) => {
      const r = await request("/network-capture");
      expect(r.status).toBe(401);
    });
  });

  test("rejects cross-origin SSE even with bearer", async () => {
    await withMiddleware(async (_origin, request) => {
      const r = await request("/network-capture", {
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: "http://evil.example" },
      });
      expect(r.status).toBe(403);
    });
  });

  test("accepts same-origin SSE with bearer", async () => {
    await withMiddleware(async (origin, request) => {
      const r = await request("/network-capture", {
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: origin },
      });
      // No booted device in unit middleware → 404 after auth.
      expect(r.status).toBe(404);
    });
  });

  test("rejects a CSRF-simple POST", async () => {
    await withMiddleware(async (_origin, request) => {
      const r = await request("/network-capture", {
        method: "POST",
        headers: { "Content-Type": "text/plain", Authorization: `Bearer ${TOKEN}` },
        body: "{}",
      });
      expect(r.status).toBe(415);
    });
  });

  test("rejects unauthenticated body GET", async () => {
    await withMiddleware(async (_origin, request) => {
      const r = await request("/network-capture/some-id");
      expect(r.status).toBe(401);
    });
  });
});
