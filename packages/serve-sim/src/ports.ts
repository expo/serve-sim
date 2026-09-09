/** TCP port ownership helpers for helper lifecycle management. */
import { execSync } from "child_process";
import { sleepSync } from "./runtime";

/**
 * Return PIDs currently *listening* on a TCP port (excluding ourselves).
 *
 * The LISTEN filter is load-bearing: a bare `lsof -ti tcp:<port>` also lists
 * processes holding *client* sockets to the port — most notably the user's
 * browser streaming MJPEG from a previous helper. Killing those SIGKILLs the
 * browser's network process, which aborts every in-flight fetch in the new
 * preview tab and surfaces as "Stream is not producing frames".
 */
export function getPortHolders(port: number): number[] {
  try {
    const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    if (!output) return [];
    const myPid = process.pid;
    const listeners = output
      .split("\n")
      .map((s) => parseInt(s, 10))
      .filter((pid) => Number.isFinite(pid) && pid !== myPid);
    const ours = listeners.filter(isServeSimProcess);
    // Refusing is the safe answer, but it leaves the caller with a port it cannot have. Name the
    // holder, or the failure surfaces much later as a bind error with nothing to explain it.
    if (listeners.length > 0 && ours.length === 0) {
      const held = listeners.map((pid) => `${pid} (${processCommand(pid) || "unknown"})`).join(", ");
      console.log(`\x1b[90mPort ${port} is held by a process that is not ours: ${held}\x1b[0m`);
    }
    return ours;
  } catch {
    return [];
  }
}

/**
 * The entrypoints this server actually runs as: the published bin, the bundled dist, or
 * src/index.ts when it runs from source, which is how the dev command and the e2e suites start it.
 *
 * Matched a token at a time, against the whole token, so a checkout directory that merely contains
 * "serve-sim" in its name does not read as the program.
 */
const SERVE_SIM_ENTRYPOINTS = [
  /(^|\/)serve-sim(\.[cm]?[jt]s)?$/,
  /(^|\/)serve-sim\/src\/index\.ts$/,
];

/**
 * Only ever kill our own helpers. The port is caller-chosen (the preview asks for a device on a
 * given port), and a wildcard bind reports a loopback-held port as free, so without this a request
 * for someone else's port would SIGKILL whatever is listening there.
 */
function isServeSimProcess(pid: number): boolean {
  return processCommand(pid)
    .split(/\s+/)
    .some((token) => SERVE_SIM_ENTRYPOINTS.some((entry) => entry.test(token)));
}

/** -ww so a long argument vector is not truncated: a cut-off path reads as somebody else's. */
function processCommand(pid: number): string {
  try {
    return execSync(`ps -ww -p ${pid} -o command=`, { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

/** Kill whatever process is listening on a given port. Logs the PIDs being killed. */
export function killPortHolder(port: number): void {
  const pids = getPortHolders(port);
  if (pids.length === 0) return;
  console.log(`\x1b[90mPort ${port} busy, killing listener pid(s): ${pids.join(", ")}\x1b[0m`);
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  sleepSync(100);
}
