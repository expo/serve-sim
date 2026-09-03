import { execFile } from "child_process";
import { existsSync } from "fs";

// The preview page drives the simulator through this fixed set of actions. Under --require-token the
// preview link is shareable, so the control socket must not also be a shell: every action below runs
// a known program with an argument array built here, never a command string the page composes.

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

function params(value: unknown): Record<string, unknown> {
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
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value === "") {
    throw new InvalidHostActionError(`${name} must be a non-empty string`);
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

/** How the serve-sim CLI is invoked from here; a .ts/.js entrypoint needs its runtime in front. */
function serveSimInvocation(binPath: string, args: string[]): Invocation {
  if (/\.ts$/.test(binPath)) return { file: "bun", args: [binPath, ...args] };
  if (/\.js$/.test(binPath)) return { file: "node", args: [binPath, ...args] };
  return { file: binPath, args };
}

const CAMERA_SOURCES = ["file", "webcam", "none"] as const;
const APPEARANCES = ["light", "dark"] as const;

function buildInvocation(action: string, raw: unknown, binPath: string): Invocation {
  const p = params(raw);
  const serveSim = (args: string[]): Invocation => serveSimInvocation(binPath, args);

  switch (action) {
    case "appearance.get":
      return { file: "xcrun", args: ["simctl", "ui", str(p, "udid"), "appearance"] };
    case "appearance.set":
      return {
        file: "xcrun",
        args: ["simctl", "ui", str(p, "udid"), "appearance", oneOf(p, "value", APPEARANCES)],
      };
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
    case "camera.mirror":
      return serveSim(["camera", "mirror", str(p, "value"), "-d", str(p, "udid"), "--quiet"]);
    case "camera.stopWebcam":
      return serveSim(["camera", "--stop-webcam", "-d", str(p, "udid")]);
    case "permissions.set":
      return serveSim([
        "permissions",
        str(p, "action"),
        str(p, "service"),
        str(p, "bundleId"),
        "-d",
        str(p, "udid"),
      ]);
    case "permissions.resetAll":
      return serveSim(["permissions", "reset", "all", str(p, "bundleId"), "-d", str(p, "udid")]);
    case "screenshot.capture":
      return { file: "xcrun", args: ["simctl", "io", str(p, "udid"), "screenshot", str(p, "path")] };
    case "screenshot.thumbnail":
      return {
        file: "sips",
        args: ["-Z", "320", str(p, "path"), "--out", str(p, "out")],
      };
    default:
      throw new InvalidHostActionError(`unknown action ${action}`);
  }
}

export function isHostActionRequest(msg: HostActionRequest): boolean {
  return typeof msg.action === "string";
}

export async function runHostActionAsync(
  msg: HostActionRequest,
  binPath: string,
): Promise<HostActionResult> {
  if (typeof msg.action !== "string") {
    throw new InvalidHostActionError("action must be a string");
  }
  const { file, args } = buildInvocation(msg.action, msg.params, binPath);
  return await new Promise<HostActionResult>((resolve) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
      });
    });
  });
}

/** Exported for the callers that resolve the running serve-sim entrypoint. */
export function resolveServeSimBin(argv1: string | undefined): string {
  try {
    if (argv1 && existsSync(argv1)) return argv1;
  } catch {}
  return "serve-sim";
}
