import type { ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import type { Config as NgrokConfig } from "@ngrok/ngrok";

export interface Tunnel {
  url: string;
  pid?: number;
  child?: ChildProcess;
  stop(): void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

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
    timeoutMs?: number;
    domain?: string;
    label?: string;
  },
): Promise<Tunnel> {
  return startNgrokTunnel(port, {
    timeoutMs: opts?.timeoutMs,
    domain: opts?.domain,
    label: opts?.label,
  });
}

export function validateTunnelCliOptions(opts: {
  tunnel?: boolean;
  detach?: boolean;
  preview?: boolean;
  tunnelDomain?: string;
}): string | null {
  if (!opts.tunnel) {
    return opts.tunnelDomain ? "--tunnel-domain requires --tunnel." : null;
  }
  if (opts.detach) {
    return "--tunnel starts a preview tunnel and cannot be combined with --detach.";
  }
  if (opts.preview === false) {
    return "--tunnel starts a preview tunnel and cannot be combined with --no-preview.";
  }
  return null;
}

async function startNgrokTunnel(
  port: number,
  opts?: { timeoutMs?: number; domain?: string; label?: string },
): Promise<Tunnel> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const forward = await loadNgrokForward();
  const domain = opts?.domain ? buildNgrokDomain(opts.domain, opts.label) : undefined;
  const forwardOpts: NgrokConfig = { addr: port };
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

async function loadNgrokForward(): Promise<typeof import("@ngrok/ngrok").forward> {
  try {
    const { forward } = await import("@ngrok/ngrok");
    if (typeof forward !== "function") {
      throw new Error("@ngrok/ngrok does not export forward()");
    }
    return forward;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Unable to load @ngrok/ngrok: ${message}. Run \`bun install\` or install the package before using --tunnel.`,
    );
  }
}

export function buildNgrokDomain(domain: string, label?: string): string {
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
