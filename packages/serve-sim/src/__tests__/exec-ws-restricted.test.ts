import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { simMiddleware } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";

const PORT = 3467;
const TOKEN = "exec-ws-restricted-token";

let server: PreviewServer;

beforeAll(async () => {
  const middleware = simMiddleware({
    basePath: "/",
    execToken: TOKEN,
    device: "DEVICE-A",
    requirePreviewToken: true,
  });
  server = await servePreview({ port: PORT, middleware, host: "127.0.0.1" });
});

afterAll(() => {
  server?.stop(true);
});

interface Reply {
  ready?: boolean;
  id?: number;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
}

function connect(): Promise<{
  next: () => Promise<Reply>;
  send: (body: Record<string, unknown>) => void;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/exec-ws`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    } as unknown as string[]);
    const queue: Reply[] = [];
    const waiters: Array<(r: Reply) => void> = [];
    const timer = setTimeout(() => reject(new Error("connect timeout")), 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({ token: TOKEN }));
      resolve({
        next: () =>
          new Promise<Reply>((r, rej) => {
            const queued = queue.shift();
            if (queued) return r(queued);
            const bail = setTimeout(() => rej(new Error("reply timeout")), 5000);
            waiters.push((reply) => {
              clearTimeout(bail);
              r(reply);
            });
          }),
        send: (body) => ws.send(JSON.stringify(body)),
        close: () => ws.close(),
      });
    };
    ws.onmessage = (event) => {
      const reply = JSON.parse(String(event.data)) as Reply;
      const waiter = waiters.shift();
      if (waiter) waiter(reply);
      else queue.push(reply);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("socket error"));
    };
  });
}

describe("gated exec-ws accepts typed actions only", () => {
  test("refuses a free-form shell command", async () => {
    const channel = await connect();
    expect((await channel.next()).ready).toBe(true);

    channel.send({ id: 1, command: "echo owned" });
    const reply = await channel.next();

    expect(reply.id).toBe(1);
    expect(reply.exitCode).toBe(1);
    expect(reply.stdout).toBe("");
    expect(reply.stderr).toMatch(/typed simulator actions only/i);
    channel.close();
  });

  test("refuses an action outside the allowed set", async () => {
    const channel = await connect();
    await channel.next();

    channel.send({ id: 2, action: "shell.run", params: { command: "echo owned" } });
    const reply = await channel.next();

    expect(reply.id).toBe(2);
    expect(reply.error).toMatch(/unknown action/i);
    channel.close();
  });

  test("runs an allowed action", async () => {
    const channel = await connect();
    await channel.next();

    channel.send({ id: 3, action: "appearance.get", params: { udid: "DEVICE-A" } });
    const reply = await channel.next();

    expect(reply.id).toBe(3);
    expect(reply.exitCode).toEqual(expect.any(Number));
    expect(reply.error).toBeUndefined();
    channel.close();
  });
});
