import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { simMiddleware } from "../middleware";
import { accessCookieName } from "../session-auth";
import { servePreview, type PreviewServer } from "../runtime";

// Every other exec suite connects without an Origin header, which is the one thing a browser
// always sends. That is why a cross-origin page could be closed while holding a valid token and
// no test noticed. These connect the way a browser does.

const PORT = 3473;
const GATED_PORT = 3474;
const TOKEN = "exec-ws-origin-token";

let server: PreviewServer;
let gatedServer: PreviewServer;

beforeAll(async () => {
  const middleware = simMiddleware({
    basePath: "/",
    execToken: TOKEN,
    device: "DEVICE-A",
    corsOrigins: ["https://expo.dev", "https://*.staging.expo.dev", "https://expo.test:13001"],
  });
  server = await servePreview({ port: PORT, middleware, host: "127.0.0.1" });
  gatedServer = await servePreview({
    port: GATED_PORT,
    host: "127.0.0.1",
    middleware: simMiddleware({
      basePath: "/",
      execToken: TOKEN,
      device: "DEVICE-A",
      corsOrigins: ["https://expo.dev"],
      requirePreviewToken: true,
    }),
  });
});

afterAll(() => {
  server?.stop(true);
  gatedServer?.stop(true);
});

type Outcome = "ready" | "refused" | "hung";

/**
 * "ready" when the channel authenticates, "refused" when the server closes it, "hung" when it
 * does neither. A refused socket must close, not merely stay silent, or a test asserting a
 * refusal would also pass against a server that simply never answered.
 */
function connectFrom(
  origin: string | null,
  { token = TOKEN, subprotocol = true }: { token?: string; subprotocol?: boolean } = {},
): Promise<Outcome> {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${PORT}/exec-ws`,
      subprotocol ? [`serve-sim.token.${token}`] : [],
      { headers: origin ? { Origin: origin } : {} },
    );
    let settled = false;
    const settle = (outcome: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(() => settle("hung"), 3000);
    ws.on("message", (raw) => {
      settle((JSON.parse(String(raw)) as { ready?: boolean }).ready === true ? "ready" : "refused");
    });
    ws.on("close", () => settle("refused"));
    ws.on("error", () => settle("refused"));
  });
}

describe("exec-ws origin policy", () => {
  test("lets a configured origin open the channel with a valid token", async () => {
    expect(await connectFrom("https://expo.dev")).toBe("ready");
  });

  test("matches a configured origin by wildcard, so deploy previews connect", async () => {
    expect(await connectFrom("https://pr-31018.staging.expo.dev")).toBe("ready");
  });

  test("keeps the port, so a dev server on another port is not the configured one", async () => {
    expect(await connectFrom("https://expo.test:13001")).toBe("ready");
    expect(await connectFrom("https://expo.test:13002")).toBe("refused");
  });

  // Each refusal below carries a VALID token, so only the origin can be the reason.
  test("refuses an origin nobody configured", async () => {
    expect(await connectFrom("https://evil.test")).toBe("refused");
    expect(await connectFrom("https://expo.dev.evil.test")).toBe("refused");
  });

  test("refuses another loopback port, which CORS would have allowed", async () => {
    // Loopback reads the preview without a flag, and an ungated server serves it `execToken`.
    // Honouring that here would hand one localhost page another session's host actions.
    expect(await connectFrom("http://localhost:3000")).toBe("refused");
  });

  test("refuses the literal null a sandboxed document sends", async () => {
    expect(await connectFrom("null")).toBe("refused");
  });

  test("still accepts the page serve-sim serves itself", async () => {
    expect(await connectFrom(`http://127.0.0.1:${PORT}`)).toBe("ready");
  });

  test("refuses a scheme no browser sends, even on the server's own host", async () => {
    // Matching on host alone would admit this; a browser only ever sends http or https.
    expect(await connectFrom(`ws://127.0.0.1:${PORT}`)).toBe("refused");
  });

  test("still accepts a client that sends no Origin at all", async () => {
    expect(await connectFrom(null)).toBe("ready");
  });

  test("a configured origin offering no credential is left to the token gate, not admitted", async () => {
    // It passes the origin check, so it must NOT answer `ready` on the strength of that alone.
    expect(await connectFrom("https://expo.dev", { subprotocol: false })).not.toBe("ready");
  });

  test("a configured origin offering the wrong token is refused", async () => {
    expect(await connectFrom("https://expo.dev", { token: "wrong-token" })).toBe("refused");
  });
});

// The deployment this change is for: --require-token on, so assertUpgradeAccess is live in front
// of the origin check rather than inert.
describe("exec-ws origin policy, token gate on", () => {
  function connectGated(origin: string, headers: Record<string, string>): Promise<Outcome> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${GATED_PORT}/exec-ws`, [], {
        headers: { Origin: origin, ...headers },
      });
      let settled = false;
      const settle = (outcome: Outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.terminate();
        resolve(outcome);
      };
      const timer = setTimeout(() => settle("hung"), 3000);
      ws.on("message", (raw) =>
        settle((JSON.parse(String(raw)) as { ready?: boolean }).ready === true ? "ready" : "refused"),
      );
      ws.on("close", () => settle("refused"));
      ws.on("error", () => settle("refused"));
    });
  }

  test("a configured origin opens it with the token subprotocol", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${GATED_PORT}/exec-ws`, [`serve-sim.token.${TOKEN}`], {
      headers: { Origin: "https://expo.dev" },
    });
    const outcome = await new Promise<Outcome>((resolve) => {
      const timer = setTimeout(() => resolve("hung"), 3000);
      ws.on("message", (raw) => {
        clearTimeout(timer);
        resolve((JSON.parse(String(raw)) as { ready?: boolean }).ready === true ? "ready" : "refused");
      });
      ws.on("close", () => {
        clearTimeout(timer);
        resolve("refused");
      });
    });
    ws.terminate();
    expect(outcome).toBe("ready");
  });

  // The cookie is the one ambient credential, and letting a named origin through the origin check
  // must not make it usable from that origin. The same-origin rule guarding it lives in
  // assertUpgradeAccess, independently of the check this file exercises.
  test("refuses a configured origin presenting only the access cookie", async () => {
    const cookie = `${accessCookieName(TOKEN)}=${TOKEN}`;
    expect(await connectGated("https://expo.dev", { Cookie: cookie })).toBe("refused");
    expect(await connectGated("https://evil.test", { Cookie: cookie })).toBe("refused");
  });

  test("refuses a configured origin with no credential at all", async () => {
    expect(await connectGated("https://expo.dev", {})).toBe("refused");
  });
});
