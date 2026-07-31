// Capture engine: mitmproxy, driven by a loopback control port.
//
// Only the app the session relaunched reaches this proxy — an injected library sets the proxy on that
// process alone, never on the host — so everything arriving here is traffic we were asked to record.

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

import { clampBody, type CaptureStore } from "./capture-store";
import { dirnameOf } from "./runtime";

// Bun's bundler inlines a bare `__dirname` as the build machine's source directory, which would make a
// published bundle look for the binary under a path that only exists on the machine that built it.
const __dirname = dirnameOf(import.meta.url);

/** How long mitmdump gets to start listening before we call it a failure. */
const STARTUP_TIMEOUT_MS = 30_000;
const STARTUP_POLL_MS = 200;

/** Shared by the session that creates a confdir and the sweep that reclaims abandoned ones. */
const CONFDIR_PREFIX = "serve-sim-capture-";

/** Ceiling on requests awaiting their response, so aborted ones can't accumulate. */
const PENDING_LIMIT = 1000;

/** Cap on a control-port request body. The addon already clamps; this bounds a malformed sender. */
const MAX_CONTROL_BODY_BYTES = 4 * 1024 * 1024;

export interface CaptureProxy {
  /** Loopback address the app is pointed at, e.g. "127.0.0.1:9123". */
  address: string;
  /**
   * File holding the port, for the injected library to read at app launch.
   *
   * The port is passed as a path rather than as a number so a stale reference cannot outlive the proxy:
   * this file lives in the session's confdir, which is removed on every death path including a signal, so
   * an app launched after the proxy is gone finds nothing and leaves its networking alone. A bare port
   * number left in the simulator's environment would instead point at a freely reassigned high port.
   */
  portFile: string;
  /** PEM of the root the device must trust, for `simctl keychain … add-root-cert`. */
  caPem: () => Promise<string>;
  close: () => Promise<void>;
}

/**
 * The developer's own mitmdump, or null if they don't have one.
 *
 * Deliberately not shipped and not downloaded. mitmproxy's standalone build is ~87MB and cannot be
 * slimmed — removing the parts we don't use invalidates its code signature, after which macOS refuses to
 * launch it — so bundling would grow the published package sevenfold for a feature many installs never
 * touch, and fetching it at runtime would mean a silent 52MB wait the first time someone opens the panel.
 *
 * Asking instead is honest about what capture is: opt-in tooling that terminates TLS, in the same class
 * as Charles or Proxyman, which are also separate installs. `mitmdumpMissingMessage` makes the fix a
 * single command.
 */
/** Homebrew on Apple Silicon and Intel, then the standalone app bundle from mitmproxy.org. */
const MITMDUMP_CANDIDATES = [
  "/opt/homebrew/bin/mitmdump",
  "/usr/local/bin/mitmdump",
  "/Applications/mitmproxy.app/Contents/MacOS/mitmdump",
];

export function locateMitmdump(
  deps: {
    which?: (name: string) => string | null;
    /** Injected so a test's result does not depend on what the machine happens to have installed. */
    candidates?: string[];
  } = {},
): string | null {
  // A set override is authoritative: falling through to a discovered copy would silently ignore what the
  // developer asked for, and the caller reports a bad override by name rather than as "not installed".
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

/** What, why, and how — the panel shows this verbatim when capture cannot start. */
export function mitmdumpMissingMessage(override?: string): string {
  // A set-but-unusable override is a different problem, and telling that developer to install software
  // they already have sends them the wrong way entirely.
  if (override) {
    return (
      `SERVE_SIM_MITMDUMP points at ${override}, which isn't a runnable file. Point it at the mitmdump ` +
      "executable, or unset it to use the copy on your PATH."
    );
  }
  return (
    "Network capture needs mitmproxy, which isn't installed. It decrypts your app's HTTPS so the " +
    "requests can be shown, and it isn't bundled because it is an 87MB signed binary that most projects " +
    "never need.\n\nInstall it with:  brew install mitmproxy\n\nOr download it from " +
    "https://mitmproxy.org/downloads and drag mitmproxy.app to /Applications. Then start capture again. " +
    "If it lives somewhere unusual, point SERVE_SIM_MITMDUMP at the mitmdump executable."
  );
}

/**
 * Path to the addon mitmproxy loads.
 *
 * Cannot be bundled: mitmproxy reads it as a Python file from disk, in its own process. Copied to
 * `dist/` at build time, and found relative to this module in both layouts.
 */
function locateAddon(): string {
  const candidates = [
    join(__dirname, "mitm-addon", "expocapture.py"),
    join(__dirname, "..", "dist", "mitm-addon", "expocapture.py"),
    join(__dirname, "..", "src", "mitm-addon", "expocapture.py"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Could not find expocapture.py, the addon that reports captured traffic. This build of serve-sim " +
      "is missing dist/mitm-addon; reinstall from a recent release.",
  );
}

/** Executable and a regular file — `existsSync` also accepts a directory, which spawns as EACCES. */
function isRunnable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove confdirs left by sessions that were killed before they could clean up.
 *
 * Each session's confdir holds the private key of the authority it asked the simulator to trust. Trusting
 * that authority is only harmless while the key is gone, and a SIGKILL skips `close()` — so the sweep is
 * what makes the missing untrust safe rather than merely convenient. A directory still owned by a live
 * proxy is left alone.
 */
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
    // Still referenced by a running proxy: that session owns it.
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
        server.close(() => reject(new Error("Could not reserve a local port for the capture proxy")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CONTROL_BODY_BYTES) {
        req.destroy();
        reject(new Error("control body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** One half of a record as the addon reports it: headers, byte count, and a bounded body. */
interface RecordPart {
  headers?: Record<string, string>;
  size?: number;
  body?: string | null;
  base64?: string | null;
  truncated?: boolean;
}

/** A finished request. Complete by construction — the addon reports only settled flows. */
interface FinishedRecord {
  id?: string;
  method?: string;
  url?: string;
  status?: number | null;
  ttfbMs?: number | null;
  durationMs?: number | null;
  /** Set when the origin was never reached; mutually exclusive with a status. */
  error?: string | null;
  req?: RecordPart;
  res?: RecordPart;
}

/**
 * The addon sends text bodies inline and binary ones as base64.
 *
 * A binary body is reported as binary rather than decoded: running one through `toString("utf8")` yields
 * replacement characters, which the panel would then render as a wall of mojibake. The byte count still
 * comes from the record, so the row stays accurate even when the body is not shown.
 */
function bodyText(part: RecordPart | undefined): {
  text: string | null;
  truncated: boolean;
  binary: boolean;
} {
  if (part?.body) return { ...clampBody([Buffer.from(part.body, "utf8")]), binary: false };
  if (part?.base64) return { text: null, truncated: part.truncated ?? false, binary: true };
  return { text: null, truncated: false, binary: false };
}

/**
 * A failure reason a developer can act on, keeping the raw text as detail.
 *
 * The proxy reports these as Python errno strings — "[Errno 61] Connect call failed ('127.0.0.1', 9)" —
 * which describe what happened at the socket but not what it means for the app.
 */
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

/**
 * Pids of the mitmproxy processes started for one session, found by its confdir.
 *
 * The shipped `mitmdump` is an app-bundle launcher, so killing the child we spawned is not guaranteed to
 * take the process actually holding the port — the same shape as the previous engine, where two survived
 * a clean shutdown. A session's confdir is created by `mkdtemp`, so its name is unique and appears in the
 * command line of every process started with it; that makes it an exact key for this session and never
 * for a mitmproxy the developer runs themselves.
 */
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
  /**
   * Called if the proxy dies while a session is using it.
   *
   * Not cosmetic: the injected app keeps sending every request to that now-dead port, so its networking
   * is broken until it is relaunched. Without this the panel would keep reporting capture as attached and
   * simply stop adding rows, which reads as "the app went quiet".
   */
  onUnexpectedExit?: (reason: string) => void;
}

export async function startMitmProxy(
  store: CaptureStore,
  deps: MitmProxyDeps = {},
): Promise<CaptureProxy> {
  // Reclaim keys left behind by a killed session before adding another.
  sweepStaleConfdirs();

  const mitmdump = locateMitmdump();
  if (!mitmdump) throw new Error(mitmdumpMissingMessage(process.env.SERVE_SIM_MITMDUMP));
  const addon = locateAddon();

  const [proxyPort, controlPort] = await Promise.all([freePort(), freePort()]);
  // Per-session, so the certificate authority is created here and destroyed with the session rather than
  // living in the developer's home directory across runs.
  const confdir = mkdtempSync(join(tmpdir(), CONFDIR_PREFIX));
  const caFile = join(confdir, "mitmproxy-ca-cert.pem");
  const portFile = join(confdir, "proxy-port");

  // The control port is loopback-only, but any local process could still post to it and inject rows or
  // drive the reader. A per-session secret in the path makes that require the secret.
  const token = randomBytes(16).toString("hex");

  // mitmproxy ids are opaque; the store keys on its own, so the two are bridged here rather than leaking
  // mitmproxy identifiers into the streamed record.
  const storeIdByFlowId = new Map<string, string>();

  // Resolved when the addon posts /ready from mitmproxy's `running` hook. That is the only evidence the
  // hooks are installed: mitmproxy writes its certificate and opens its port even when the addon fails
  // to import, so a file-or-port check reports a capture that will never record anything.
  let announceReady = () => {};
  const addonReady = new Promise<void>((resolve) => {
    announceReady = resolve;
  });

  /** Fold a settled record into the store: the row, its headers and bodies, and its byte counts. */
  const recordFinished = (storeId: string, record: FinishedRecord) => {
    const requestBytes = record.req?.size ?? 0;
    const responseBytes = record.res?.size ?? 0;
    const request = bodyText(record.req);
    const response = bodyText(record.res);

    store.setBody(storeId, {
      requestHeaders: record.req?.headers ?? {},
      responseHeaders: record.res?.headers ?? {},
      requestBody: request.text,
      responseBody: response.text,
      requestTruncated: request.truncated || (record.req?.truncated ?? false),
      responseTruncated: response.truncated || (record.res?.truncated ?? false),
      requestBinary: request.binary,
      responseBinary: response.binary,
    });

    // Throughput has to come from these byte counts. The app reaches the network through the proxy over
    // loopback, which the host's counters deliberately exclude — so they report the app as idle and the
    // graph would sit flat. What the proxy moved is the only remaining measure.
    store.noteTraffic(responseBytes, requestBytes, record.durationMs ?? 0);

    store.update(
      storeId,
      {
        status: record.status ?? null,
        mimeType: record.res?.headers?.["content-type"] ?? null,
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
          // A flow that never settles would otherwise linger. The map is a bridge, not a record; the
          // store already bounds what is kept, so the oldest pending ids are dropped.
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
      .catch(() => {
        res.writeHead(400).end();
      });
  });

  await new Promise<void>((resolve, reject) => {
    control.once("error", reject);
    control.listen(controlPort, "127.0.0.1", () => resolve());
  });
  // After startup a server-level error would otherwise be an uncaught exception.
  control.on("error", () => {});

  writeFileSync(portFile, String(proxyPort));

  const child: ChildProcess = spawn(
    mitmdump,
    [
      "-q",
      // Loopback only: the proxy must not be reachable from the network the developer is on.
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
        EXPO_CAPTURE_CONTROL_URL: `http://127.0.0.1:${controlPort}`,
        EXPO_CAPTURE_CONTROL_TOKEN: token,
      },
    },
  );

  // Kept only to explain a failed start; a mid-session crash is reported through the session instead.
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
  // Without this a spawn failure is an uncaught exception under Node and a silent rejection under Bun.
  // The message is kept rather than the error, so the reason survives into the thrown startup failure.
  let spawnError = "";
  child.once("error", (error: Error) => {
    exited = true;
    spawnError = error.message;
  });

  const marker = basename(confdir);

  /** Signal this session's mitmproxy processes. Synchronous so an exit hook can use it too. */
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

  // A crash or a kill would otherwise leave a proxy listening with nothing to shut it down, still holding
  // the private key of the authority the simulator was told to trust. Synchronous, because that is all an
  // exit handler can be — Node abandons pending async work here.
  //
  // `exit` alone is not enough: Node does not emit it for signal termination, so a SIGTERM or a Ctrl-C
  // left the proxy running. Each signal is handled explicitly and then re-raised with the default
  // disposition, so this does not change how the process dies.
  const reapOnExit = () => {
    signalWorkers("SIGKILL");
    rmSync(confdir, { recursive: true, force: true });
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const reapOnSignal = (signal: NodeJS.Signals) => {
    reapOnExit();
    process.removeListener("exit", reapOnExit);
    for (const other of signals) process.removeListener(other, reapOnSignal);
    process.kill(process.pid, signal);
  };
  process.once("exit", reapOnExit);
  for (const signal of signals) process.on(signal, reapOnSignal);

  const close = async (): Promise<void> => {
    closing = true;
    try {
      if (!exited && child.pid != null) {
        // Bounded: a child that refuses to die must not hang teardown, and the sweep below reaches it
        // anyway.
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
    // The launcher exiting does not guarantee the process holding the port went with it.
      signalWorkers("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      signalWorkers("SIGKILL");
      await new Promise<void>((resolve) => control.close(() => resolve()));
      // Takes the session's certificate authority with it.
      rmSync(confdir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } finally {
      // Deregistered last: until the kill has actually happened, these are the only thing that would
      // reap a proxy if this process died mid-teardown.
      process.removeListener("exit", reapOnExit);
      for (const signal of signals) process.removeListener(signal, reapOnSignal);
    }
  };

  // Two things must be true: mitmproxy must have written its certificate (so it can sign), and the addon
  // must have announced itself (so records will actually be reported). Either alone is a false positive.
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
