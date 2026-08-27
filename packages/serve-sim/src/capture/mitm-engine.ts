import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { clampBody, type CaptureStore } from "./store";
import {
  DEFAULT_CAPTURE_FIELDS,
  applyCaptureFields,
  captureFieldSet,
  type CaptureField,
} from "./fields";
import { fetchMitmdumpIfAllowed } from "./mitm-fetch";
import { redactHeaders } from "./redact";
import { dirnameOf } from "../runtime";

// Bun inlines bare `__dirname` as the build machine's path; resolve from import.meta instead.
const __dirname = dirnameOf(import.meta.url);

const STARTUP_TIMEOUT_MS = 30_000;
const STARTUP_POLL_MS = 200;
const CONFDIR_PREFIX = "serve-sim-capture-";
const PENDING_LIMIT = 1000;

/** Default cap on mitm → control POSTs so a runaway JSON body can't OOM the Node heap. */
export const DEFAULT_MAX_CONTROL_BODY_BYTES = 10 * 1024 * 1024;
export const MAX_CONTROL_BODY_BYTES_ENV = "SERVE_SIM_CAPTURE_MAX_CONTROL_BODY_BYTES";

/** Resolve the control-body byte cap; override with SERVE_SIM_CAPTURE_MAX_CONTROL_BODY_BYTES. */
export function maxControlBodyBytes(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
  const raw = env[MAX_CONTROL_BODY_BYTES_ENV]?.trim();
  if (!raw) return DEFAULT_MAX_CONTROL_BODY_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_CONTROL_BODY_BYTES;
  return Math.floor(parsed);
}

export interface OversizedControlBodyInfo {
  bytesSeen: number;
  limit: number;
  path: string;
}

class ControlBodyTooLargeError extends Error {
  constructor(
    readonly bytesSeen: number,
    readonly limit: number,
  ) {
    super(`control body too large (${bytesSeen} > ${limit})`);
    this.name = "ControlBodyTooLargeError";
  }
}

/** Terminal + UI copy when a mitm control POST is dropped for size. */
export function formatOversizedControlBodyWarning(info: OversizedControlBodyInfo): string {
  return (
    `[capture] Dropped oversized control body on ${info.path} ` +
    `(${info.bytesSeen} > ${info.limit} bytes). Raise ${MAX_CONTROL_BODY_BYTES_ENV} to allow larger posts.`
  );
}

export interface CaptureProxy {
  address: string;
  /** Port file for the injected library; lives in the session confdir. */
  portFile: string;
  caPem: () => Promise<string>;
  close: () => Promise<void>;
}

const MITMDUMP_CANDIDATES = [
  "/opt/homebrew/bin/mitmdump",
  "/usr/local/bin/mitmdump",
  "/Applications/mitmproxy.app/Contents/MacOS/mitmdump",
];

export function locateMitmdump(
  deps: {
    which?: (name: string) => string | null;
    candidates?: string[];
  } = {},
): string | null {
  const override = process.env.SERVE_SIM_MITMDUMP;
  if (override) return isRunnable(override) ? override : null;

  const onPath =
    deps.which ??
    ((name: string) => {
      const found = spawnSync("which", [name], { encoding: "utf8" });
      const path = found.status === 0 ? found.stdout.trim() : "";
      return path ? path : null;
    });
  const fromPath = onPath("mitmdump");
  if (fromPath) return fromPath;

  for (const candidate of deps.candidates ?? MITMDUMP_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function mitmdumpMissingMessage(override?: string): string {
  if (override) {
    return (
      `SERVE_SIM_MITMDUMP points at ${override}, which isn't a runnable file. Point it at the mitmdump ` +
      "executable, or unset it to use the copy on your PATH."
    );
  }
  return (
    "Network capture needs mitmproxy, which isn't installed. It terminates HTTP(S) so the " +
    "requests can be shown, and it isn't bundled because it is an 87MB signed binary that most projects " +
    "never need.\n\nInstall it with:  brew install mitmproxy\n\nOr download it from " +
    "https://mitmproxy.org/downloads and drag mitmproxy.app to /Applications. Then start capture again. " +
    "If it lives somewhere unusual, point SERVE_SIM_MITMDUMP at the mitmdump executable."
  );
}

function locateAddon(): string {
  const candidates = [
    join(__dirname, "mitm-addon", "servesim_capture.py"),
    join(__dirname, "..", "dist", "capture", "mitm-addon", "servesim_capture.py"),
    join(__dirname, "..", "src", "capture", "mitm-addon", "servesim_capture.py"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Could not find servesim_capture.py, the addon that reports captured traffic. This build of serve-sim " +
      "is missing dist/capture/mitm-addon; reinstall from a recent release.",
  );
}

function isRunnable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Remove abandoned confdirs (each holds a CA private key); leave dirs still referenced in `ps`. */
export function sweepStaleConfdirs(deps: { list?: () => string[]; remove?: (dir: string) => void; psOutput?: () => string } = {}): number {
  const list =
    deps.list ??
    (() => {
      try {
        return readdirSync(tmpdir())
          .filter((name) => name.startsWith(CONFDIR_PREFIX))
          .map((name) => join(tmpdir(), name));
      } catch {
        return [];
      }
    });
  const psOutput =
    deps.psOutput ??
    (() => {
      const listed = spawnSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
      return listed.status === 0 && typeof listed.stdout === "string" ? listed.stdout : "";
    });
  const remove = deps.remove ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }));

  const processes = psOutput();
  let swept = 0;
  for (const dir of list()) {
    if (processes.includes(basename(dir))) continue;
    try {
      remove(dir);
      swept++;
    } catch {
      // Another process may be sweeping the same directory.
    }
  }
  return swept;
}

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address == null || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve a local port for the capture proxy.")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const limit = maxControlBodyBytes();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        req.destroy();
        reject(new ControlBodyTooLargeError(size, limit));
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (rejected) return;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

interface RecordPart {
  mime?: string | null;
  headers?: Record<string, string>;
  size?: number;
  body?: string | null;
  base64?: string | null;
  truncated?: boolean;
}

interface FinishedRecord {
  id?: string;
  method?: string;
  url?: string;
  status?: number | null;
  ttfbMs?: number | null;
  durationMs?: number | null;
  error?: string | null;
  req?: RecordPart;
  res?: RecordPart;
}

function bodyText(part: RecordPart | undefined): {
  text: string | null;
  truncated: boolean;
  binary: boolean;
} {
  if (part?.body != null) return { ...clampBody([Buffer.from(part.body, "utf8")]), binary: false };
  if (part?.base64 != null) return { text: null, truncated: part.truncated ?? false, binary: true };
  return { text: null, truncated: false, binary: false };
}

export function describeFailure(raw: string): string {
  if (/Errno 61|Connect call failed|refused/i.test(raw)) {
    return `Nothing was listening at the address the app connected to. (${raw})`;
  }
  if (/Errno 8|nodename nor servname|Name or service not known|getaddrinfo/i.test(raw)) {
    return `The host could not be resolved. (${raw})`;
  }
  if (/certificate|CERTIFICATE_VERIFY|SSL|TLS/i.test(raw)) {
    return (
      "The app rejected the capture certificate, so this request could not be inspected — an app that pins " +
      `its certificates refuses any proxy. (${raw})`
    );
  }
  if (/timed out|ETIMEDOUT|Errno 60/i.test(raw)) {
    return `The host accepted the connection but never replied. (${raw})`;
  }
  return raw;
}

/** mitmdump is an app-bundle launcher; killing only the spawned child may miss the port holder. */
export function parseMitmPids(psOutput: string, marker: string, selfPid: number): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    if (!line.includes(marker)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isFinite(pid) && pid !== selfPid) pids.push(pid);
  }
  return pids;
}

export interface MitmProxyDeps {
  /** Parts of an exchange this session is allowed to keep. Metadata only when omitted. */
  fields?: readonly CaptureField[];
  onUnexpectedExit?: (reason: string) => void;
  /** Fired when a control POST is rejected before JSON.parse (body over the byte cap). */
  onOversizedControlBody?: (info: OversizedControlBodyInfo) => void;
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** One set of process listeners for all proxies: a proxy per device would otherwise trip MaxListeners. */
const reapers = new Set<() => void>();
let listening = false;

function reapAll(): void {
  for (const reap of reapers) {
    try {
      reap();
    } catch {
      // One proxy's cleanup must not strand the others'.
    }
  }
}

function onSignal(signal: NodeJS.Signals): void {
  reapAll();
  process.removeListener("exit", reapAll);
  for (const other of SIGNALS) process.removeListener(other, onSignal);
  process.kill(process.pid, signal);
}

function addReaper(reap: () => void): void {
  reapers.add(reap);
  if (listening) return;
  listening = true;
  process.once("exit", reapAll);
  for (const signal of SIGNALS) process.on(signal, onSignal);
}

function removeReaper(reap: () => void): void {
  reapers.delete(reap);
}

export async function startMitmProxy(
  store: CaptureStore,
  deps: MitmProxyDeps = {},
): Promise<CaptureProxy> {
  sweepStaleConfdirs();

  const mitmdump =
    locateMitmdump() ?? fetchMitmdumpIfAllowed((message) => console.log(message));
  if (!mitmdump) throw new Error(mitmdumpMissingMessage(process.env.SERVE_SIM_MITMDUMP));
  const addon = locateAddon();

  const fields = deps.fields ?? DEFAULT_CAPTURE_FIELDS;
  const allowed = captureFieldSet(fields);

  const [proxyPort, controlPort] = await Promise.all([freePort(), freePort()]);
  const confdir = mkdtempSync(join(tmpdir(), CONFDIR_PREFIX));
  const caFile = join(confdir, "mitmproxy-ca-cert.pem");
  const portFile = join(confdir, "proxy-port");

  // Per-session token gates posts to the loopback control port.
  const token = randomBytes(16).toString("hex");

  const storeIdByFlowId = new Map<string, string>();

  // Addon posts /ready from mitmproxy's `running` hook — CA file alone is not enough.
  let announceReady = () => {};
  const addonReady = new Promise<void>((resolve) => {
    announceReady = resolve;
  });

  const recordFinished = (storeId: string, record: FinishedRecord) => {
    const requestBytes = record.req?.size ?? 0;
    const responseBytes = record.res?.size ?? 0;
    const request = bodyText(record.req);
    const response = bodyText(record.res);

    store.setBody(
      storeId,
      applyCaptureFields(
        {
          requestHeaders: redactHeaders(record.req?.headers ?? {}),
          responseHeaders: redactHeaders(record.res?.headers ?? {}),
          requestBody: request.text,
          responseBody: response.text,
          requestTruncated: request.truncated || (record.req?.truncated ?? false),
          responseTruncated: response.truncated || (record.res?.truncated ?? false),
          requestBinary: request.binary,
          responseBinary: response.binary,
        },
        allowed,
      ),
    );

    store.noteTraffic(responseBytes, requestBytes, record.durationMs ?? 0);

    store.update(
      storeId,
      {
        status: record.status ?? null,
        // From its own field: under the default policy the header map is empty, and MIME type is
        // documented as metadata the panel always gets.
        mimeType: record.res?.mime ?? record.res?.headers?.["content-type"] ?? null,
        requestBytes,
        responseBytes,
        ttfbMs: record.ttfbMs ?? null,
        durationMs: record.durationMs ?? null,
        failure: record.error ? describeFailure(record.error) : null,
      },
      /* settled */ true,
    );
  };

  const control = createServer((req: IncomingMessage, res: ServerResponse) => {
    const route = new URL(req.url ?? "/", "http://127.0.0.1");
    const reply = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (route.searchParams.get("t") !== token) {
      res.writeHead(403).end();
      return;
    }
    if (route.pathname === "/ready") {
      announceReady();
      reply({ ok: true });
      return;
    }

    void readJsonBody(req)
      .then((payload) => {
        const record = (payload ?? {}) as FinishedRecord;
        if (record.id == null) return reply({ ok: false });

        if (route.pathname === "/request") {
          while (storeIdByFlowId.size >= PENDING_LIMIT) {
            const oldest = storeIdByFlowId.keys().next();
            if (oldest.done) break;
            storeIdByFlowId.delete(oldest.value);
          }
          storeIdByFlowId.set(record.id, store.start(record.method ?? "GET", record.url ?? ""));
          return reply({ ok: true });
        }
        if (route.pathname === "/response") {
          const storeId = storeIdByFlowId.get(record.id);
          if (storeId == null) return reply({ ok: false });
          storeIdByFlowId.delete(record.id);
          recordFinished(storeId, record);
          return reply({ ok: true });
        }
        res.writeHead(404).end();
      })
      .catch((error) => {
        if (error instanceof ControlBodyTooLargeError) {
          const info: OversizedControlBodyInfo = {
            bytesSeen: error.bytesSeen,
            limit: error.limit,
            path: route.pathname,
          };
          console.warn(formatOversizedControlBodyWarning(info));
          deps.onOversizedControlBody?.(info);
          res.writeHead(413).end();
          return;
        }
        res.writeHead(400).end();
      });
  });

  await new Promise<void>((resolve, reject) => {
    control.once("error", reject);
    control.listen(controlPort, "127.0.0.1", () => resolve());
  });
  control.on("error", () => {});

  writeFileSync(portFile, String(proxyPort));

  const child: ChildProcess = spawn(
    mitmdump,
    [
      "-q",
      "--listen-host",
      "127.0.0.1",
      "--listen-port",
      String(proxyPort),
      "--set",
      `confdir=${confdir}`,
      "-s",
      addon,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SERVE_SIM_CAPTURE_CONTROL_URL: `http://127.0.0.1:${controlPort}`,
        SERVE_SIM_CAPTURE_CONTROL_TOKEN: token,
        // The addon drops everything not listed before a record is even built.
        SERVE_SIM_CAPTURE_FIELDS: fields.join(","),
        [MAX_CONTROL_BODY_BYTES_ENV]: String(maxControlBodyBytes()),
      },
    },
  );

  let output = "";
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-4000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  let exited = false;
  let closing = false;
  child.once("exit", (code) => {
    exited = true;
    if (closing) return;
    deps.onUnexpectedExit?.(
      output.trim() || `The capture proxy stopped unexpectedly (exit ${code ?? "signal"}).`,
    );
  });
  let spawnError = "";
  child.once("error", (error: Error) => {
    exited = true;
    spawnError = error.message;
  });

  const marker = basename(confdir);

  const signalWorkers = (signal: "SIGTERM" | "SIGKILL"): void => {
    const listed = spawnSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
    if (listed.status !== 0 || typeof listed.stdout !== "string") return;
    for (const pid of parseMitmPids(listed.stdout, marker, process.pid)) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone between listing and signalling.
      }
    }
  };

  // Sync reap on exit/signal — `exit` alone misses SIGTERM/Ctrl-C.
  const reapOnExit = () => {
    signalWorkers("SIGKILL");
    rmSync(confdir, { recursive: true, force: true });
  };
  addReaper(reapOnExit);

  const close = async (): Promise<void> => {
    closing = true;
    try {
      if (!exited && child.pid != null) {
        const gone = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        child.kill("SIGTERM");
        const escalate = setTimeout(() => child.kill("SIGKILL"), 3000);
        await gone;
        clearTimeout(escalate);
      }
      // Launcher exit does not guarantee the port holder died with it.
      signalWorkers("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      signalWorkers("SIGKILL");
      await new Promise<void>((resolve) => control.close(() => resolve()));
      rmSync(confdir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } finally {
      removeReaper(reapOnExit);
    }
  };

  // Need both CA file and addon /ready; either alone is a false positive.
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let announced = false;
  void addonReady.then(() => {
    announced = true;
  });
  while (Date.now() < deadline) {
    if (exited) {
      await close();
      throw new Error(
        `The capture proxy exited before it started listening.\n${
          spawnError || output.trim() || "No output from mitmproxy."
        }`,
      );
    }
    if (existsSync(caFile) && announced) {
      return {
        address: `127.0.0.1:${proxyPort}`,
        portFile,
        caPem: async () => readFileSync(caFile, "utf8"),
        close,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
  }

  const stalled = existsSync(caFile)
    ? "It started but its reporting addon never loaded, so nothing would have been captured."
    : `Check that no other process holds 127.0.0.1:${proxyPort}.`;
  await close();
  throw new Error(
    `The capture proxy did not start within ${STARTUP_TIMEOUT_MS / 1000}s. ${stalled}\n${output.trim()}`,
  );
}
