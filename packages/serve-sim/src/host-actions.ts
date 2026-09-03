import { execFile } from "child_process";
import { appendFile, mkdir, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";

// The preview page drives the simulator through this fixed set of actions. Under --require-token the
// preview link is shareable, so the control socket must not also be a shell: an action either runs a
// known program with an argument array built here, or is handled in process. Nothing the page sends
// is ever interpreted by a shell.

export interface HostActionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface HostActionRequest {
  action?: unknown;
  params?: unknown;
}

/** Program and argument vector for one action. `execFile` never involves a shell. */
interface Invocation {
  file: string;
  args: string[];
}

export class InvalidHostActionError extends Error {}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  if (typeof value !== "string" || value === "") {
    throw new InvalidHostActionError(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalStr(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new InvalidHostActionError(`${name} must be a string`);
  }
  return value;
}

function oneOf<T extends string>(
  source: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T {
  const value = str(source, name);
  if (!allowed.includes(value as T)) {
    throw new InvalidHostActionError(`${name} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function coordinate(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new InvalidHostActionError(`${name} must be a number`);
  }
  return numeric.toFixed(7);
}

/** Icon file names to probe, supplied by the caller from Info.plist. Names only, never paths. */
function fileNames(source: Record<string, unknown>, name: string): string[] {
  const value = source[name];
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new InvalidHostActionError(`${name} must be a list of 1 to 32 file names`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || !/^[^/\\]{1,255}$/.test(entry) || entry.startsWith(".")) {
      throw new InvalidHostActionError(`${name} entries must be plain file names`);
    }
    return entry;
  });
}

/** Scratch space for uploads. Confining them here keeps a path param from reaching the filesystem. */
const UPLOAD_DIR = join(tmpdir(), "serve-sim-uploads");

/** An upload is addressed by an opaque id, never by a caller-supplied path. */
function uploadPath(source: Record<string, unknown>): string {
  const id = str(source, "uploadId");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || id.startsWith(".")) {
    throw new InvalidHostActionError("uploadId must be a short alphanumeric name");
  }
  return join(UPLOAD_DIR, basename(id));
}

/** How the serve-sim CLI is invoked; a .ts/.js entrypoint needs its runtime in front. */
function serveSimInvocation(binPath: string, args: string[]): Invocation {
  if (/\.ts$/.test(binPath)) return { file: "bun", args: [binPath, ...args] };
  if (/\.js$/.test(binPath)) return { file: "node", args: [binPath, ...args] };
  return { file: binPath, args };
}

const CAMERA_SOURCES = ["file", "webcam", "none"] as const;
const APPEARANCES = ["light", "dark"] as const;
const PERMISSION_ACTIONS = ["grant", "revoke", "reset"] as const;
const MIRROR_VALUES = ["on", "off"] as const;

function buildInvocation(action: string, raw: unknown, binPath: string): Invocation {
  const p = fields(raw);
  const serveSim = (args: string[]): Invocation => serveSimInvocation(binPath, args);
  const simctl = (args: string[]): Invocation => ({ file: "xcrun", args: ["simctl", ...args] });

  switch (action) {
    case "appearance.get":
      return simctl(["ui", str(p, "udid"), "appearance"]);
    case "appearance.set":
      return simctl(["ui", str(p, "udid"), "appearance", oneOf(p, "value", APPEARANCES)]);
    case "location.set":
      return simctl([
        "location",
        str(p, "udid"),
        "set",
        `${coordinate(p, "lat")},${coordinate(p, "lng")}`,
      ]);
    case "location.clear":
      return simctl(["location", str(p, "udid"), "clear"]);
    case "home.springboard":
      return simctl(["launch", str(p, "udid"), "com.apple.springboard"]);
    case "home.watch":
      return {
        file: "osascript",
        args: [
          "-e",
          'tell application "System Events" to tell process "Simulator" to set frontmost to true',
          "-e",
          'tell application "System Events" to tell process "Simulator" to perform action "AXRaise" of (first window whose name contains "watchOS")',
          "-e",
          'tell application "System Events" to tell process "Simulator" to click menu item "Home" of menu "Device" of menu bar item "Device" of menu bar 1',
        ],
      };
    case "rotate":
      return serveSim(["rotate", str(p, "value"), "-d", str(p, "udid")]);
    case "button":
      return serveSim(["button", str(p, "value")]);
    case "server.detach": {
      const device = optionalStr(p, "udid");
      return serveSim(["--detach", ...(device ? [device] : [])]);
    }
    case "server.kill":
      return serveSim(["--kill"]);
    case "camera.listWebcams":
      return serveSim(["camera", "--list-webcams"]);
    case "camera.switch": {
      const source = oneOf(p, "source", CAMERA_SOURCES);
      const target = optionalStr(p, "target");
      return serveSim([
        "camera",
        "switch",
        source,
        ...(target ? [target] : []),
        "-d",
        str(p, "udid"),
        "--quiet",
      ]);
    }
    case "camera.configure": {
      const source = oneOf(p, "source", CAMERA_SOURCES);
      const target = optionalStr(p, "target");
      const args = ["camera"];
      if (source === "file") args.push("--file", str(p, "target"));
      else if (source === "webcam") args.push("--webcam", ...(target ? [target] : []));
      args.push("--mirror", oneOf(p, "mirror", MIRROR_VALUES), "-d", str(p, "udid"), "--quiet");
      return serveSim(args);
    }
    case "camera.mirror":
      return serveSim([
        "camera",
        "mirror",
        oneOf(p, "value", MIRROR_VALUES),
        "-d",
        str(p, "udid"),
        "--quiet",
      ]);
    case "camera.stopWebcam":
      return serveSim(["camera", "--stop-webcam", "-d", str(p, "udid")]);
    case "permissions.set":
      return serveSim([
        "permissions",
        oneOf(p, "action", PERMISSION_ACTIONS),
        str(p, "service"),
        str(p, "bundleId"),
        "-d",
        str(p, "udid"),
      ]);
    case "permissions.resetAll":
      return serveSim(["permissions", "reset", "all", str(p, "bundleId"), "-d", str(p, "udid")]);
    case "app.container":
      return simctl(["get_app_container", str(p, "udid"), str(p, "bundleId"), "app"]);
    case "app.infoPlist":
      return { file: "plutil", args: ["-convert", "json", "-o", "-", str(p, "path")] };
    case "app.install":
      return simctl(["install", str(p, "udid"), uploadPath(p)]);
    case "media.add":
      return simctl(["addmedia", str(p, "udid"), uploadPath(p)]);
    case "reveal":
      return { file: "open", args: ["-R", str(p, "path")] };
    default:
      throw new InvalidHostActionError(`unknown action ${action}`);
  }
}

function runInvocation({ file, args }: Invocation): Promise<HostActionResult> {
  return new Promise<HostActionResult>((resolve) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
      });
    });
  });
}

function ok(stdout = ""): HostActionResult {
  return { stdout, stderr: "", exitCode: 0 };
}

/**
 * Actions handled without spawning anything. Uploads arrive as base64 chunks, which would blow past
 * ARG_MAX as arguments, so they are decoded and appended here instead.
 */
async function runInProcessAsync(
  action: string,
  raw: unknown,
): Promise<HostActionResult | null> {
  const p = fields(raw);
  switch (action) {
    case "upload.append": {
      const target = uploadPath(p);
      const chunk = Buffer.from(str(p, "data"), "base64");
      await mkdir(UPLOAD_DIR, { recursive: true });
      if (p.first === true) await writeFile(target, chunk);
      else await appendFile(target, chunk);
      return ok(target);
    }
    case "upload.remove":
      await rm(uploadPath(p), { force: true });
      return ok();
    case "app.iconPath": {
      const appPath = str(p, "appPath");
      for (const candidate of fileNames(p, "candidates")) {
        const full = join(appPath, candidate);
        try {
          if ((await stat(full)).isFile()) return ok(full);
        } catch {}
      }
      return { stdout: "", stderr: "no icon found", exitCode: 1 };
    }
    case "file.readBase64": {
      const result = await runInvocation({ file: "base64", args: ["-i", str(p, "path")] });
      return result;
    }
    case "screenshot.capture": {
      const target = join(UPLOAD_DIR, `serve-sim-screenshot-${Date.now()}.png`);
      await mkdir(UPLOAD_DIR, { recursive: true });
      const result = await runInvocation({
        file: "xcrun",
        args: ["simctl", "io", str(p, "udid"), "screenshot", target],
      });
      return result.exitCode === 0 ? ok(target) : result;
    }
    case "screenshot.thumbnail": {
      const source = str(p, "path");
      const thumb = `${source}.thumb.png`;
      const sips = await runInvocation({
        file: "sips",
        args: ["-Z", "320", source, "--out", thumb],
      });
      if (sips.exitCode !== 0) return sips;
      const encoded = await runInvocation({ file: "base64", args: ["-i", thumb] });
      await rm(thumb, { force: true });
      return encoded;
    }
    default:
      return null;
  }
}

export async function runHostActionAsync(
  msg: HostActionRequest,
  binPath: string,
): Promise<HostActionResult> {
  if (typeof msg.action !== "string") {
    throw new InvalidHostActionError("action must be a string");
  }
  const inProcess = await runInProcessAsync(msg.action, msg.params);
  if (inProcess) return inProcess;
  return await runInvocation(buildInvocation(msg.action, msg.params, binPath));
}
