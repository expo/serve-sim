import { describe, expect, test } from "bun:test";
import { simMiddleware } from "../middleware";

const TOKEN = "test-token-abc123";

async function withMiddleware<T>(
  fn: (
    origin: string,
    request: (path: string, init?: RequestInit) => Promise<Response>
  ) => Promise<T>
): Promise<T> {
  const handler = simMiddleware({ basePath: "/", execToken: TOKEN });
  const origin = "http://127.0.0.1:34567";
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await handler(new Request(`${origin}${path}`, init));
    if (!response) throw new Error(`Unhandled request: ${path}`);
    return response;
  };
  return fn(origin, request);
}

const authorized = { Authorization: `Bearer ${TOKEN}` };

describe("/crashes auth", () => {
  test("rejects a request with no token", async () => {
    await withMiddleware(async (_origin, request) => {
      expect((await request("/crashes")).status).toBe(401);
    });
  });

  test("rejects a wrong token", async () => {
    await withMiddleware(async (_origin, request) => {
      const response = await request("/crashes", { headers: { Authorization: "Bearer nope" } });
      expect(response.status).toBe(401);
    });
  });

  test("rejects a malformed Authorization header", async () => {
    await withMiddleware(async (_origin, request) => {
      for (const Authorization of [TOKEN, `Basic ${TOKEN}`, "Bearer", "Bearer "]) {
        expect((await request("/crashes", { headers: { Authorization } })).status).toBe(401);
      }
    });
  });

  test("rejects a cross-origin read even with the token", async () => {
    await withMiddleware(async (_origin, request) => {
      const response = await request("/crashes", {
        headers: { ...authorized, Origin: "http://evil.example" },
      });
      expect(response.status).toBe(403);
    });
  });

  test("lets a same-origin read with the token through", async () => {
    await withMiddleware(async (origin, request) => {
      const response = await request("/crashes", { headers: { ...authorized, Origin: origin } });
      expect(response.status).toBe(404);
    });
  });

  test("lets a read with no Origin header through", async () => {
    await withMiddleware(async (_origin, request) => {
      expect((await request("/crashes", { headers: authorized })).status).toBe(404);
    });
  });

  test("gates the detail route before the record lookup", async () => {
    await withMiddleware(async (_origin, request) => {
      expect((await request("/crashes/INC-1")).status).toBe(401);
    });
  });

  test("answers 400 for a bad percent-encoded id", async () => {
    await withMiddleware(async (_origin, request) => {
      const response = await request("/crashes/%", { headers: authorized });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("Invalid crash id");
    });
  });

  test("treats a trailing slash as the list route, not an empty id", async () => {
    await withMiddleware(async (_origin, request) => {
      const response = await request("/crashes/", { headers: authorized });
      expect(response.status).toBe(404);
      expect((await response.json()).error).toContain("No serve-sim device");
    });
  });
});
