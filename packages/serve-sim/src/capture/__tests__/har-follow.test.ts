import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { followCaptureHar } from "../har-follow";

describe("followCaptureHar", () => {
  it("accumulates SSE frames and rewrites the HAR file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-"));
    const outPath = join(dir, "session.har");

    const frames = [
      "event: meta\ndata: {\"schemaVersion\":1,\"udid\":\"D\",\"attachment\":\"capturing\"}\n\n",
      'data: {"type":"started","request":{"id":"r1","method":"GET","url":"https://a.test/","status":null,"mimeType":null,"requestBytes":0,"responseBytes":0,"startedAt":1,"ttfbMs":null,"durationMs":null,"failure":null}}\n\n',
      'data: {"type":"finished","request":{"id":"r1","method":"GET","url":"https://a.test/","status":200,"mimeType":"text/plain","requestBytes":0,"responseBytes":2,"startedAt":1,"ttfbMs":1,"durationMs":2,"failure":null}}\n\n',
    ];
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= frames.length) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(frames[i++]));
      },
    });

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/network-capture/r1")) {
        return new Response(
          JSON.stringify({
            requestHeaders: {},
            responseHeaders: { "content-type": "text/plain" },
            requestBody: null,
            responseBody: "ok",
            requestTruncated: false,
            responseTruncated: false,
            requestBinary: false,
            responseBinary: false,
          }),
          { status: 200 },
        );
      }
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    try {
      const result = await followCaptureHar({
        baseUrl: "http://127.0.0.1:3999",
        device: "D",
        outPath,
        flushIntervalMs: 50,
        fetchImpl,
        version: "test",
        token: "test-token",
      });
      expect(result.size).toBe(1);
      const har = JSON.parse(readFileSync(outPath, "utf8"));
      expect(har.log.entries).toHaveLength(1);
      expect(har.log.entries[0].response.content.text).toBe("ok");

      const events = readFileSync(join(dir, "network-capture.json"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string });
      expect(events.some((e) => e.type === "started")).toBe(true);
      expect(events.some((e) => e.type === "finished")).toBe(true);
      expect(existsSync(result.entriesPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
