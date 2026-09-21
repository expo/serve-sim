import { createHash } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import modelBase64 from "./client/assets/iphone-duo-model.glb.base64" with { type: "text" };

// Keep the model in the server bundle, outside the preview HTML, so other devices
// never download it. Decode once, only when a Duo preview requests the asset.
let model: { body: Buffer; etag: string } | undefined;

export function serveDuoModelAsset(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }

  if (!model) {
    const body = Buffer.from(modelBase64, "base64");
    model = { body, etag: `"${createHash("sha256").update(body).digest("hex")}"` };
  }
  const { body, etag } = model;
  const headers = { "Cache-Control": "private, no-cache", ETag: etag };
  const ifNoneMatch = req.headers["if-none-match"];
  const matches = typeof ifNoneMatch === "string" && ifNoneMatch.split(",").some((value) => {
    const candidate = value.trim();
    return candidate === "*" || candidate.replace(/^W\//, "") === etag;
  });
  if (matches) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, {
    ...headers,
    "Content-Type": "model/gltf-binary",
    "Content-Length": String(body.length),
  });
  res.end(req.method === "HEAD" ? undefined : body);
}
