import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getPortHolders } from "../ports";

// getPortHolders feeds killPortHolder, which SIGKILLs its results before a
// helper (re)spawn. It must therefore return only the *listener* on the port,
// and only when that listener is one of ours — see port-holders.test.ts.
// A client connected to the port — the user's browser pulling /stream.mjpeg
// from a previous helper — must never be listed: SIGKILLing the browser's
// network process aborts every in-flight fetch in the new preview tab, which
// is exactly the "Stream is not producing frames" failure.

const PORT = 3461;

function spawnNode(script: string, asHelper = false): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const args = asHelper ? [helperScript(script), "serve-sim"] : ["-e", script];
    const child = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.once("data", () => resolve(child));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`child exited early (${code})`)));
  });
}

let listener: ChildProcess;
let client: ChildProcess;
let scriptDir: string | undefined;

/** A file named like a helper, so the process passes the ownership check killPortHolder applies. */
function helperScript(script: string): string {
  scriptDir ??= mkdtempSync(join(tmpdir(), "serve-sim-ports-"));
  const file = join(scriptDir, "serve-sim.js");
  writeFileSync(file, script);
  return file;
}

beforeAll(async () => {
  listener = await spawnNode(
    `const net = require("net");
     const srv = net.createServer((s) => s.pipe(s));
     srv.listen(${PORT}, "127.0.0.1", () => console.log("ready"));`,
    true,
  );
  client = await spawnNode(
    `const net = require("net");
     const s = net.connect(${PORT}, "127.0.0.1", () => console.log("connected"));
     s.on("error", () => {});
     setInterval(() => {}, 1000);`,
  );
});

afterAll(() => {
  client?.kill("SIGKILL");
  listener?.kill("SIGKILL");
  if (scriptDir) rmSync(scriptDir, { recursive: true, force: true });
});

describe("getPortHolders", () => {
  test("returns the listener pid", () => {
    expect(getPortHolders(PORT)).toContain(listener.pid!);
  });

  test("does not return pids of connected clients", () => {
    expect(getPortHolders(PORT)).not.toContain(client.pid!);
  });
});
