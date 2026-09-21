import { describe, expect, test } from "bun:test";
import { simMiddleware } from "../middleware";

const TOKEN = "duo-model-asset-test";
const ASSET_PATH = "/assets/iphone-duo/model.glb";

function requestModel(basePath: string, init?: RequestInit, authenticated = true) {
  const middleware = simMiddleware({ basePath, execToken: TOKEN, requirePreviewToken: true });
  const headers = new Headers(init?.headers);
  if (authenticated) headers.set("Authorization", `Bearer ${TOKEN}`);
  return middleware(new Request(`http://localhost${basePath === "/" ? "" : basePath}${ASSET_PATH}`, {
    ...init,
    headers,
  }));
}

describe("bundled iPhone Duo model", () => {
  test("serves a complete, self-contained GLB at the root mount", async () => {
    const response = await requestModel("/");
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Content-Type")).toBe("model/gltf-binary");
    const body = Buffer.from(await response!.arrayBuffer());
    expect(body.toString("ascii", 0, 4)).toBe("glTF");
    expect(body.readUInt32LE(4)).toBe(2);
    expect(body.readUInt32LE(8)).toBe(body.length);
    expect(Number(response?.headers.get("Content-Length"))).toBe(body.length);

    const jsonLength = body.readUInt32LE(12);
    expect(body.toString("ascii", 16, 20)).toBe("JSON");
    const gltf = JSON.parse(body.toString("utf8", 20, 20 + jsonLength)) as {
      meshes: unknown[];
      buffers: Array<{ uri?: string }>;
      images?: Array<{ uri?: string; bufferView?: number }>;
    };
    expect(gltf.meshes.length).toBeGreaterThan(0);
    expect(gltf.buffers.every((buffer) => !buffer.uri)).toBe(true);
    expect(gltf.images?.every((image) => !image.uri && image.bufferView !== undefined) ?? true).toBe(true);
  });

  test("serves HEAD under a nested middleware base without sending the model", async () => {
    const response = await requestModel("/preview/simulator", { method: "HEAD" });
    expect(response?.status).toBe(200);
    expect(Number(response?.headers.get("Content-Length"))).toBeGreaterThan(20);
    expect(await response?.text()).toBe("");
    expect(response?.headers.get("ETag")).toMatch(/^"[a-f0-9]{64}"$/);
  });

  test("revalidates cached geometry without retransmitting it", async () => {
    const first = await requestModel("/preview", { method: "HEAD" });
    const etag = first!.headers.get("ETag")!;
    const response = await requestModel("/preview", { headers: { "If-None-Match": `"old", W/${etag}` } });
    expect(response?.status).toBe(304);
    expect(response?.headers.get("ETag")).toBe(etag);
    expect(response?.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(await response?.text()).toBe("");
  });

  test("requires preview authentication before serving or revalidating geometry", async () => {
    const response = await requestModel("/preview", { headers: { "If-None-Match": "*" } }, false);
    expect(response?.status).toBe(401);
    expect(response?.headers.get("ETag")).toBeNull();
  });

  test("rejects methods other than GET and HEAD", async () => {
    const response = await requestModel("/", { method: "POST" });
    expect(response?.status).toBe(405);
    expect(response?.headers.get("Allow")).toBe("GET, HEAD");
  });
});
