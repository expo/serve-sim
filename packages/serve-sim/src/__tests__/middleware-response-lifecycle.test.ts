import { describe, expect, test } from "bun:test";
import type { ServerResponse } from "http";
import {
  connectToFetch,
  type ConnectMiddleware,
} from "../connect-to-fetch";

describe("fetch middleware response lifecycle", () => {
  test("emits close with writableFinished after a normal response", async () => {
    let finishedOnClose = false;
    const handler: ConnectMiddleware = async (_req, res) => {
      res.once("close", () => {
        finishedOnClose = res.writableFinished;
      });
      res.end("ok");
    };

    const response = await connectToFetch(handler, new Request("http://localhost/test"));

    expect(await response?.text()).toBe("ok");
    expect(finishedOnClose).toBe(true);
  });

  test("emits close with destroyed when a streaming consumer cancels", async () => {
    let responseOnClose: ServerResponse | undefined;
    const handler: ConnectMiddleware = async (_req, res) => {
      res.once("close", () => {
        responseOnClose = res;
      });
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.write("frame");
    };

    const response = await connectToFetch(handler, new Request("http://localhost/stream"));
    const reader = response!.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("frame");
    await reader.cancel();

    expect(responseOnClose?.destroyed).toBe(true);
    expect(responseOnClose?.writableFinished).toBe(false);
  });

  test("applies Web Stream backpressure to Connect responses", async () => {
    let firstWriteAccepted = true;
    const handler: ConnectMiddleware = async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      firstWriteAccepted = res.write("first");
      if (!firstWriteAccepted) {
        res.once("drain", () => res.end("second"));
      }
    };

    const response = await connectToFetch(handler, new Request("http://localhost/stream"));
    expect(firstWriteAccepted).toBe(false);
    expect(await response?.text()).toBe("firstsecond");
  });

  test("honors statusCode assignments made before end", async () => {
    const handler: ConnectMiddleware = async (_req, res) => {
      res.statusCode = 404;
      res.end("missing");
    };

    const response = await connectToFetch(handler, new Request("http://localhost/missing"));
    expect(response?.status).toBe(404);
    expect(await response?.text()).toBe("missing");
  });

  test("propagates an aborted Fetch request to the Connect request", async () => {
    const controller = new AbortController();
    let requestClosed = false;
    const handler: ConnectMiddleware = async (req, res) => {
      req.once("close", () => {
        requestClosed = true;
        res.destroy();
      });
      res.write("frame");
    };

    const response = await connectToFetch(
      handler,
      new Request("http://localhost/stream", { signal: controller.signal }),
    );
    controller.abort();
    await response?.body?.cancel().catch(() => {});
    expect(requestClosed).toBe(true);
  });

  test("returns a rejection when a Connect handler throws synchronously", async () => {
    const handler = (() => {
      throw new Error("boom");
    }) as ConnectMiddleware;

    await expect(connectToFetch(handler, new Request("http://localhost/fail"))).rejects.toThrow("boom");
  });
});
