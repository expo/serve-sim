import { createHash } from "crypto";
import { execFileSync, execSync, spawn } from "child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { findBootedDevice, resolveDevice } from "./device";
import { sendHelperSocketCommand, type HelperReply } from "./helper-socket";
import { isCameraHelperAlive, readInjectedCameraBundles } from "./camera-helper";
import { dirnameOf, sleepSync } from "./runtime";
import { stateDir } from "./state";

const __dirname = dirnameOf(import.meta.url);

// ─── Arguments ───

export type IdleMode = "silence" | "passthrough";

export type MicCommand =
  | { verb: "launch"; bundleId: string; idle: IdleMode | undefined; build: boolean }
  | { verb: "say"; text: string; voice?: string; rate?: number; preRollMs: number; wait: boolean }
  | { verb: "play"; path: string; preRollMs: number; wait: boolean }
  | { verb: "idle"; mode: IdleMode }
  | { verb: "stop" | "status" | "off" | "voices" | "help" };

export interface MicArgs {
  command: MicCommand;
  device: string | undefined;
  quiet: boolean;
}

export class MicUsageError extends Error {}

function parseNumber(flag: string, value: string | undefined, min: number, max: number): number {
  const n = value === undefined ? NaN : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new MicUsageError(`${flag} needs a number from ${min} to ${max}`);
  }
  return n;
}

export function parseMicArgs(args: string[]): MicArgs {
  let device: string | undefined;
  let quiet = false;
  let idle: IdleMode | undefined;
  let build = false;
  let wait = false;
  let preRollMs = 0;
  let voice: string | undefined;
  let rate: number | undefined;
  let help = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = () => {
      const next = args[++i];
      if (next === undefined) throw new MicUsageError(`${a} needs a value`);
      return next;
    };
    if (a === "-d" || a === "--device") device = value();
    else if (a === "-q" || a === "--quiet") quiet = true;
    else if (a === "--passthrough") idle = "passthrough";
    else if (a === "--silence") idle = "silence";
    else if (a === "--build") build = true;
    else if (a === "--wait" || a === "-w") wait = true;
    else if (a === "--pre-roll") preRollMs = parseNumber(a, value(), 0, 60_000);
    else if (a === "--voice") voice = value();
    else if (a === "--rate" || a === "-r") rate = parseNumber(a, value(), 1, 1000);
    else if (a === "--help" || a === "-h") help = true;
    else if (a.startsWith("-") && a !== "-") throw new MicUsageError(`unknown option ${a}`);
    else positional.push(a);
  }

  const [first, ...rest] = positional;
  let command: MicCommand;
  if (help || first === undefined) {
    command = { verb: "help" };
  } else if (first === "say") {
    const text = rest.join(" ").trim();
    if (!text) throw new MicUsageError("mic say needs text");
    command = { verb: "say", text, voice, rate, preRollMs, wait };
  } else if (first === "play") {
    if (!rest[0]) throw new MicUsageError("mic play needs a file");
    command = { verb: "play", path: resolve(rest[0]), preRollMs, wait };
  } else if (first === "idle") {
    const mode = rest[0];
    if (mode !== "silence" && mode !== "passthrough") {
      throw new MicUsageError("mic idle needs silence or passthrough");
    }
    command = { verb: "idle", mode };
  } else if (first === "stop" || first === "status" || first === "off" || first === "voices") {
    command = { verb: first };
  } else {
    command = { verb: "launch", bundleId: first, idle, build };
  }
  return { command, device, quiet };
}

// ─── Helper state ───

function micStateDir(): string {
  return join(stateDir(), "simmic");
}

function shortHash(udid: string, length: number): string {
  return createHash("sha1").update(udid).digest("hex").slice(0, length);
}

function helperPidFile(udid: string): string {
  return join(micStateDir(), `${udid}.pid`);
}

function helperBundlesFile(udid: string): string {
  return join(micStateDir(), `${udid}.bundles.json`);
}

function helperSocketFile(udid: string): string {
  // POSIX sun_path is 104 chars on macOS, so keep this short.
  return `/tmp/serve-sim-mic-${shortHash(udid, 12)}.sock`;
}

function shmNameForUdid(udid: string): string {
  // POSIX shm names on macOS have a 31-char limit.
  return `/serve-sim-mic-${shortHash(udid, 8)}`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readHelperPid(udid: string): number | null {
  try {
    const pid = Number(readFileSync(helperPidFile(udid), "utf-8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isHelperAlive(udid: string): boolean {
  const pid = readHelperPid(udid);
  return pid !== null && isProcessAlive(pid) && existsSync(helperSocketFile(udid));
}

function readInjectedBundles(udid: string): string[] {
  try {
    const value = JSON.parse(readFileSync(helperBundlesFile(udid), "utf-8")) as unknown;
    const state = value as { helperPid?: unknown; bundleIds?: unknown };
    if (state.helperPid !== readHelperPid(udid) || !Array.isArray(state.bundleIds)) return [];
    return state.bundleIds.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

function recordInjectedBundle(udid: string, bundleId: string, helperPid: number): void {
  const existing = readInjectedBundles(udid);
  const bundleIds = existing.includes(bundleId) ? existing : [...existing, bundleId];
  writeFileSync(helperBundlesFile(udid), JSON.stringify({ helperPid, bundleIds }));
}

// ─── Artifacts ───

function locateArtifact(name: string): string | null {
  const candidates = [
    join(__dirname, "..", "dist", "simmic", name),
    join(__dirname, "simmic", name),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return resolve(candidate);
  return null;
}

function buildArtifact(name: string, sourceDir: string): string {
  const script = join(__dirname, "..", "Sources", sourceDir, "build.sh");
  if (!existsSync(script)) {
    throw new Error(`${sourceDir} source not found; this build of serve-sim has no mic support.`);
  }
  console.error(`[serve-sim] building ${name}…`);
  execSync(`bash "${script}"`, { stdio: "inherit" });
  const built = locateArtifact(name);
  if (!built) throw new Error(`Build succeeded but ${name} was not found.`);
  return built;
}

function artifact(name: string, sourceDir: string, forceBuild: boolean): string {
  return (!forceBuild && locateArtifact(name)) || buildArtifact(name, sourceDir);
}

// ─── Helper process ───

function stopHelper(udid: string): void {
  const pid = readHelperPid(udid);
  if (pid !== null && isProcessAlive(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    const start = Date.now();
    while (isProcessAlive(pid) && Date.now() - start < 1500) sleepSync(50);
  }
  try { unlinkSync(helperPidFile(udid)); } catch {}
  try { unlinkSync(helperBundlesFile(udid)); } catch {}
}

function spawnHelper(udid: string, helperBin: string, idle: IdleMode): number {
  mkdirSync(micStateDir(), { recursive: true });
  const logPath = join(micStateDir(), `${udid}.log`);
  const socketPath = helperSocketFile(udid);
  const out = openSync(logPath, "a");
  const child = spawn(
    helperBin,
    ["--shm", shmNameForUdid(udid), "--socket", socketPath, "--idle", idle],
    { detached: true, stdio: ["ignore", out, out] },
  );
  child.unref();
  closeSync(out);
  if (!child.pid) throw new Error("failed to spawn mic helper");
  writeFileSync(helperPidFile(udid), String(child.pid));
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (!isProcessAlive(child.pid)) throw new Error(`mic helper exited early; see ${logPath}`);
    if (existsSync(socketPath)) return child.pid;
    sleepSync(50);
  }
  throw new Error(`mic helper did not open its socket; see ${logPath}`);
}

async function send(udid: string, command: object): Promise<HelperReply> {
  if (!isHelperAlive(udid)) {
    throw new Error("mic helper is not running for this device; run `serve-sim mic <bundle-id>` first.");
  }
  const reply = await sendHelperSocketCommand(helperSocketFile(udid), command, 30_000);
  if (!reply.ok) throw new Error(reply.error ?? "mic helper rejected the command");
  return reply;
}

async function waitUntilDone(udid: string, budgetMs: number): Promise<HelperReply> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const status = await send(udid, { action: "status" });
    if (!status.playing) return status;
    if (Date.now() > deadline) throw new Error("timed out waiting for playback to finish");
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ─── Commands ───

const USAGE = `Usage: serve-sim mic <bundle-id> [-d udid] [--passthrough] [--build] [-q]
       serve-sim mic say <text> [--voice name] [--rate wpm] [--pre-roll ms] [--wait] [-d udid] [-q]
       serve-sim mic play <file> [--pre-roll ms] [--wait] [-d udid] [-q]
       serve-sim mic stop | status | idle <silence|passthrough> | voices | off [-d udid]

Replaces the simulator microphone for an app with audio from the host. The
first form starts a host helper for the device, grants microphone access,
and relaunches the app with SimMicInjector loaded. Later commands feed it
audio without a relaunch.

Commands:
  <bundle-id>           Relaunch the app with the mic injected
  say <text>            Speak text with macOS text to speech
  play <file>           Play an audio file (mp3, wav, m4a, aiff, caf, ...)
  stop                  Stop the current clip
  status                Print the helper state as JSON
  idle <mode>           Between clips: silence (default) or passthrough
                        (the Mac's real microphone)
  voices                List voices for \`say --voice\`
  off                   Stop the helper and terminate the injected apps

Options:
  -d, --device <udid|name>  Target a specific simulator (default: booted)
      --passthrough         With <bundle-id>: start in passthrough idle mode
  -w, --wait                Return after the clip has played
      --pre-roll <ms>       Silence before the clip starts
      --voice <name>        Voice for say
  -r, --rate <wpm>          Speech rate for say
      --build               Rebuild the dylib and helper from source
  -q, --quiet               JSON-only output

Examples:
  serve-sim mic com.acme.MyApp
  serve-sim mic say "Add milk to my shopping list" --wait
  serve-sim mic play ~/Desktop/command.mp3 --pre-roll 300 --wait
  serve-sim mic idle passthrough`;

function targetDevice(device: string | undefined): string {
  const udid = device ? resolveDevice(device) : findBootedDevice();
  if (!udid) throw new Error("No booted simulator. Boot one or pass -d <udid|name>.");
  return udid;
}

function print(quiet: boolean, json: object, human: string): void {
  console.log(quiet ? JSON.stringify(json) : human);
}

async function launch(udid: string, cmd: Extract<MicCommand, { verb: "launch" }>, quiet: boolean) {
  const dylib = artifact("libSimMicInjector.dylib", "SimMicInjector", cmd.build);
  const helperBin = artifact("serve-sim-mic-helper", "SimMicHelper", cmd.build);

  let helperPid: number;
  let helperStarted = false;
  if (isHelperAlive(udid) && !cmd.build) {
    helperPid = readHelperPid(udid)!;
    if (cmd.idle) await send(udid, { action: "setIdle", mode: cmd.idle });
  } else {
    stopHelper(udid);
    helperPid = spawnHelper(udid, helperBin, cmd.idle ?? "silence");
    helperStarted = true;
  }

  if (isCameraHelperAlive(udid) && readInjectedCameraBundles(udid).includes(cmd.bundleId)) {
    console.error(
      `[serve-sim] ${cmd.bundleId} had the camera injected; this relaunch loads only the mic.`,
    );
  }

  try {
    execFileSync("xcrun", ["simctl", "privacy", udid, "grant", "microphone", cmd.bundleId], { stdio: "ignore" });
  } catch {}
  try {
    execFileSync("xcrun", ["simctl", "terminate", udid, cmd.bundleId], { stdio: "ignore" });
  } catch {}
  const output = execFileSync("xcrun", ["simctl", "launch", udid, cmd.bundleId], {
    env: {
      ...process.env,
      SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: dylib,
      SIMCTL_CHILD_SIMMIC_SHM_NAME: shmNameForUdid(udid),
    },
    encoding: "utf-8",
  });
  const pid = Number(output.trim().match(/:\s*(\d+)\s*$/)?.[1]) || null;
  recordInjectedBundle(udid, cmd.bundleId, helperPid);

  print(
    quiet,
    { udid, bundleId: cmd.bundleId, pid, dylib, shm: shmNameForUdid(udid), helperPid, helperStarted },
    `🎙️  Injected mic into ${cmd.bundleId} (pid ${pid ?? "?"}) on ${udid}\n` +
      `   helper pid: ${helperPid}${helperStarted ? " (started)" : ""}\n` +
      `   next: serve-sim mic say "hello" --wait`,
  );
}

async function play(udid: string, path: string, preRollMs: number, wait: boolean, quiet: boolean, label: string) {
  let reply = await send(udid, { action: "play", path, preRollMs });
  const durationMs = Number(reply.durationMs) || 0;
  if (wait) reply = await waitUntilDone(udid, durationMs + preRollMs + 10_000);
  print(quiet, { udid, ...reply }, `🎙️  ${wait ? "Played" : "Playing"} ${label} (${(durationMs / 1000).toFixed(1)} s)`);
}

async function say(udid: string, cmd: Extract<MicCommand, { verb: "say" }>, quiet: boolean) {
  if (!isHelperAlive(udid)) {
    throw new Error("mic helper is not running for this device; run `serve-sim mic <bundle-id>` first.");
  }
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-mic-"));
  try {
    const textFile = join(dir, "text.txt");
    const audioFile = join(dir, "speech.aiff");
    writeFileSync(textFile, cmd.text);
    const sayArgs = ["-o", audioFile, "-f", textFile];
    if (cmd.voice) sayArgs.push("-v", cmd.voice);
    if (cmd.rate) sayArgs.push("-r", String(cmd.rate));
    execFileSync("say", sayArgs, { stdio: ["ignore", "ignore", "pipe"] });
    // The helper decodes the whole file before it replies, so it can go after.
    await play(udid, audioFile, cmd.preRollMs, cmd.wait, quiet, `"${cmd.text}"`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function off(udid: string, quiet: boolean) {
  const terminated: string[] = [];
  for (const bundleId of readInjectedBundles(udid)) {
    try {
      execFileSync("xcrun", ["simctl", "terminate", udid, bundleId], { stdio: "ignore" });
      terminated.push(bundleId);
    } catch {}
  }
  stopHelper(udid);
  print(quiet, { udid, stopped: true, terminated }, `Stopped mic helper for ${udid}` +
    (terminated.length ? `\nTerminated injected apps: ${terminated.join(", ")}` : ""));
}

/** `serve-sim mic …` */
export async function mic(args: string[], options: { quiet?: boolean } = {}): Promise<void> {
  let parsed: MicArgs;
  try {
    parsed = parseMicArgs(args);
  } catch (error) {
    if (!(error instanceof MicUsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(1);
  }
  const { command } = parsed;
  const quiet = parsed.quiet || Boolean(options.quiet);
  if (command.verb === "help") {
    console.log(USAGE);
    return;
  }
  if (command.verb === "voices") {
    execFileSync("say", ["-v", "?"], { stdio: "inherit" });
    return;
  }

  try {
    const udid = targetDevice(parsed.device);
    switch (command.verb) {
      case "launch":
        return await launch(udid, command, quiet);
      case "say":
        return await say(udid, command, quiet);
      case "play":
        if (!existsSync(command.path)) throw new Error(`File not found: ${command.path}`);
        return await play(udid, command.path, command.preRollMs, command.wait, quiet, command.path);
      case "stop": {
        const reply = await send(udid, { action: "stop" });
        return print(quiet, { udid, ...reply }, "🎙️  Stopped playback");
      }
      case "idle": {
        const reply = await send(udid, { action: "setIdle", mode: command.mode });
        return print(quiet, { udid, ...reply }, `🎙️  Idle mode → ${command.mode}`);
      }
      case "status": {
        const alive = isHelperAlive(udid);
        const reply = alive ? await send(udid, { action: "status" }) : {};
        console.log(JSON.stringify({
          udid,
          alive,
          helperPid: alive ? readHelperPid(udid) : null,
          bundleIds: readInjectedBundles(udid),
          ...reply,
        }));
        return;
      }
      case "off":
        return await off(udid, quiet);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (quiet) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(message);
    process.exit(1);
  }
}
