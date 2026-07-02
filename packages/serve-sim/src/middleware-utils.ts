const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type SseSink = {
  readonly closed: boolean;
  write(chunk: string): void;
  close(): void;
};

export function requestHost(request: Request, url: URL): string | undefined {
  return request.headers.get("host") ?? url.host ?? undefined;
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function textResponse(value: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "text/plain; charset=utf-8");
  }
  return new Response(value, { ...init, headers });
}

export function noStoreJsonResponse(value: unknown, status = 200): Response {
  return jsonResponse(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function sseResponse(setup: (sink: SseSink) => void | (() => void)): Response {
  let cleanup: (() => void) | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        try { cleanup?.(); } catch {}
        try { controller.close(); } catch {}
      };
      const sink: SseSink = {
        get closed() {
          return closed;
        },
        write(chunk: string) {
          if (closed) return;
          try {
            controller.enqueue(textEncoder.encode(chunk));
          } catch {
            close();
          }
        },
        close,
      };

      try {
        cleanup = setup(sink) ?? undefined;
      } catch (error) {
        closed = true;
        controller.error(error);
      }
    },
    cancel() {
      if (closed) return;
      closed = true;
      try { cleanup?.(); } catch {}
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function readTextBody(request: Request, maxBytes?: number): Promise<
  { ok: true; text: string } | { ok: false; response: Response }
> {
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (maxBytes !== undefined && size > maxBytes) {
        await reader.cancel().catch(() => {});
        return {
          ok: false,
          response: jsonResponse(
            { stdout: "", stderr: "Payload Too Large", exitCode: 1 },
            { status: 413 },
          ),
        };
      }
      text += textDecoder.decode(value, { stream: true });
    }
    text += textDecoder.decode();
    return { ok: true, text };
  } finally {
    reader.releaseLock();
  }
}
