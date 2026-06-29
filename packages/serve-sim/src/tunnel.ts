import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";

export interface Tunnel {
  url: string;
  pid?: number;
  child?: ChildProcess;
  stop(): void;
}

export type TunnelProtocol = "auto" | "quic" | "http2";
export type TunnelProvider = "cloudflare" | "ngrok";

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const DEFAULT_TIMEOUT_MS = 30_000;

const NOT_FOUND_HINT =
  "cloudflared not found on PATH. Install it with `brew install cloudflared` " +
  "(macOS) or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/.";

type NgrokListener = {
  url(): string | null;
  close(): Promise<void>;
};

type NgrokForward = (opts: Record<string, unknown>) => Promise<NgrokListener>;

export function randomTunnelLabel(prefix: string): string {
  const normalized = prefix
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "serve-sim";
  return `${normalized}-${randomBytes(4).toString("hex")}`;
}

export function startTunnel(
  port: number,
  opts?: {
    provider?: TunnelProvider;
    timeoutMs?: number;
    protocol?: TunnelProtocol;
    domain?: string;
    label?: string;
  },
): Promise<Tunnel> {
  const provider = opts?.provider ?? "cloudflare";
  if (provider === "ngrok") {
    return startNgrokTunnel(port, {
      timeoutMs: opts?.timeoutMs,
      domain: opts?.domain,
      label: opts?.label,
    });
  }
  return startCloudflareTunnel(port, {
    timeoutMs: opts?.timeoutMs,
    protocol: opts?.protocol,
  });
}

export function startCloudflareTunnel(
  port: number,
  opts?: { timeoutMs?: number; protocol?: TunnelProtocol },
): Promise<Tunnel> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const protocol = opts?.protocol;

  return new Promise<Tunnel>((resolve, reject) => {
    const args = [
      "tunnel",
      "--no-autoupdate",
      ...(protocol ? ["--protocol", protocol] : []),
      "--url",
      `http://localhost:${port}`,
    ];

    let child: ChildProcess;
    try {
      child = spawn("cloudflared", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject((err as NodeJS.ErrnoException).code === "ENOENT" ? new Error(NOT_FOUND_HINT) : err);
      return;
    }

    let resolved = false;
    let buffer = "";

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString();
      if (buffer.length > 64 * 1024) buffer = buffer.slice(-32 * 1024);
      const match = buffer.match(TRYCLOUDFLARE_RE);
      if (match && !resolved) {
        resolved = true;
        cleanup();
        resolve({
          url: match[0],
          pid: child.pid!,
          child,
          stop: () => {
            try { child.kill("SIGTERM"); } catch {}
          },
        });
      }
    };

    const onError = (err: NodeJS.ErrnoException) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      try { child.kill(); } catch {}
      reject(err.code === "ENOENT" ? new Error(NOT_FOUND_HINT) : err);
    };

    const onExit = (code: number | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      const tail = buffer.split("\n").slice(-5).join("\n").trim();
      reject(
        new Error(
          `cloudflared exited (code ${code}) before producing a URL` +
            (tail ? `:\n${tail}` : ""),
        ),
      );
    };

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      try { child.kill(); } catch {}
      reject(new Error(`cloudflared did not produce a URL within ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

async function startNgrokTunnel(
  port: number,
  opts?: { timeoutMs?: number; domain?: string; label?: string },
): Promise<Tunnel> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const forward = await loadNgrokForward();
  const domain = opts?.domain ? buildNgrokDomain(opts.domain, opts.label) : undefined;
  const forwardOpts: Record<string, unknown> = { addr: port };
  if (process.env.NGROK_AUTHTOKEN) forwardOpts.authtoken = process.env.NGROK_AUTHTOKEN;
  if (domain) forwardOpts.domain = domain;

  const listener = await withTimeout(
    forward(forwardOpts),
    timeoutMs,
    `ngrok did not produce a URL within ${timeoutMs}ms`,
    (value) => { void value.close(); },
  );
  const url = listener.url();
  if (!url) {
    await listener.close().catch(() => {});
    throw new Error("ngrok started but did not return a URL");
  }

  return {
    url,
    stop: () => {
      void listener.close().catch(() => {});
    },
  };
}

async function loadNgrokForward(): Promise<NgrokForward> {
  try {
    const mod = await import("@ngrok/ngrok") as {
      forward?: NgrokForward;
      default?: { forward?: NgrokForward };
    };
    const forward = mod.forward ?? mod.default?.forward;
    if (typeof forward !== "function") {
      throw new Error("@ngrok/ngrok does not export forward()");
    }
    return forward;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Unable to load @ngrok/ngrok: ${message}. Run \`bun install\` or install the package before using --tunnel-provider ngrok.`,
    );
  }
}

function buildNgrokDomain(domain: string, label?: string): string {
  const base = domain
    .replace(/^https?:\/\//i, "")
    .replace(/^\*\./, "")
    .replace(/\/+$/, "");
  if (!label) return base;
  return `${label}.${base}`;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  cleanup?: (value: T) => void,
): Promise<T> {
  let timedOut = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        if (timedOut) {
          cleanup?.(value);
          return;
        }
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
