import { afterEach, describe, expect, it } from "bun:test";

import { type ChildProcess, spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { getPortHolders } from "../ports";

const INNOCENT_PORT = 48831;
const HELPER_PORT = 48832;

let scratch: string | undefined;
const children: ChildProcess[] = [];

afterEach(() => {
  while (children.length) children.pop()?.kill("SIGKILL");
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A listener on loopback only, named so its command line does or does not look like ours. */
async function listenAs(name: string, port: number): Promise<void> {
  scratch ??= mkdtempSync(join(tmpdir(), "serve-sim-ports-"));
  const script = join(scratch, name);
  writeFileSync(
    script,
    `require("net").createServer(() => {}).listen(${port}, "127.0.0.1", () => console.log("up"));`,
  );
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} never listened`)), 5000);
    child.stdout?.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", reject);
  });
}

describe("who serve-sim is willing to kill for a port", () => {
  // The preview picks the port, and a wildcard bind reports a loopback-held port as free, so
  // without an ownership check a request for someone else's port SIGKILLs whatever listens there.
  it("does not target an unrelated process holding the port", async () => {
    await listenAs("ngrok.js", INNOCENT_PORT);
    expect(getPortHolders(INNOCENT_PORT)).toEqual([]);
  }, 15_000);

  it("still targets a stale serve-sim helper", async () => {
    await listenAs("serve-sim.js", HELPER_PORT);
    expect(getPortHolders(HELPER_PORT)).toHaveLength(1);
  }, 15_000);
});
