import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { appendFile, chmod, lstat, mkdir, readdir, rm, stat, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { realpathSync } from "fs";
import { join, resolve, sep } from "path";
import { z } from "zod";

// The preview link is shareable, so this is a fixed set of actions rather than a shell: no value the
// page sends ever reaches one. It bounds what a link holder can run on the host, not what they can
// do to the simulator, so the session token remains the real boundary.

export interface HostActionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface HostActionRequest {
  action?: unknown;
  params?: unknown;
}

interface Invocation {
  file: string;
  args: string[];
}

export class InvalidHostActionError extends Error {}

/** Confining uploads here keeps a caller-supplied path off the filesystem. */
const UPLOAD_DIR = join(tmpdir(), "serve-sim-uploads");
// Without a ceiling a caller could fill the disk, and a closed tab never cleans up after itself.
const MAX_UPLOAD_DIR_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_UPLOAD_AGE_MS = 6 * 60 * 60 * 1000;
/** ~3MB of raw bytes, matching the client's 192KB slices with generous headroom. */
const MAX_UPLOAD_CHUNK_BASE64 = 4 * 1024 * 1024;

// Serialized so the budget check and the write cannot interleave: concurrent callers would
// otherwise all read the same pre-write total and sail past the ceiling.
let uploadQueue: Promise<unknown> = Promise.resolve();

function queueUploadAsync<T>(work: () => Promise<T>): Promise<T> {
  const result = uploadQueue.then(work, work);
  uploadQueue = result.catch(() => {});
  return result;
}

/** mkdir's mode only applies on creation, so a directory from an earlier run keeps its mode. */
async function ensureUploadDirAsync(): Promise<void> {
  await mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  await chmod(UPLOAD_DIR, 0o700).catch(() => {});
}

/** Counted by name so unrelated Desktop files are ignored. */
const MAX_DESKTOP_SCREENSHOTS = 200;

async function desktopScreenshotBudgetExceededAsync(): Promise<boolean> {
  try {
    const entries = await readdir(join(homedir(), "Desktop"));
    return entries.filter((entry) => entry.startsWith("serve-sim-screenshot-")).length >= MAX_DESKTOP_SCREENSHOTS;
  } catch {
    return false;
  }
}

/** Drop abandoned uploads, then report what the directory still holds. */
async function pruneUploadsAsync(): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(UPLOAD_DIR);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - MAX_UPLOAD_AGE_MS;
  for (const entry of entries) {
    const full = join(UPLOAD_DIR, entry);
    try {
      const info = await lstat(full);
      if (info.mtimeMs < cutoff) await rm(full, { force: true, recursive: true });
      else total += info.size;
    } catch {
    }
  }
  return total;
}

const APPEARANCES = ["light", "dark"] as const;
const PERMISSION_ACTIONS = ["grant", "revoke", "reset"] as const;
const MIRROR_VALUES = ["on", "off"] as const;

/**
 * Every value the preview page can send. The page is reachable through a shareable link, so each
 * field is pinned to the narrowest shape that still serves the UI: an enum, a bounded identifier, a
 * number, or a path under a root this server owns.
 */
const Device = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._()-]*$/, "must be a simulator udid or device name");

const BundleId = z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must look like com.example.app");

/** An orientation or button name. Bounded rather than allowlisted, so a new button still works. */
const Token = z.string().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a plain identifier");

/** A value passed straight to a program: a leading "-" would be read as a flag. */
const Argument = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\p{C}]+$/u, "must not contain control characters")
  .refine((v) => !v.startsWith("-"), 'must not start with "-"');

const UploadId = z
  .string()
  .regex(/^(?!\.)[A-Za-z0-9._-]{1,128}$/, "must be a short plain file name");

/** A file name with no directory part, supplied by the caller from an app's Info.plist. */
const FileName = z.string().regex(/^(?!\.)[^/\\\n]{1,255}$/, "must be a plain file name");

const Coordinate = z.number().finite();

/**
 * Roots a caller-named path may sit under. Everything the preview legitimately touches is a
 * simulator app container, a screenshot this server took, or a file it staged, so anything else is
 * out of scope for a shareable preview link. Resolved first, so traversal collapses before the check.
 */
const ConfinedPath = Argument.transform((value) => {
  // realpath, not resolve: a symlink under an allowed root would otherwise point anywhere.
  try {
    return realpathSync(resolve(value));
  } catch {
    return resolve(value);
  }
}).refine((value) => {
  const roots = [
    join(homedir(), "Library", "Developer", "CoreSimulator", "Devices"),
    // Apple's own apps live in the runtime root, not under a device's data container.
    "/Library/Developer/CoreSimulator",
    join(homedir(), "Desktop"),
    UPLOAD_DIR,
  ].map((root) => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  });
  return roots.some((root) => value === root || value.startsWith(root + sep));
}, "is outside the paths this preview may read");

/** Either a file this server staged, or a path the host itself produced. */
const FileSource = z.union([
  z.object({ uploadId: UploadId }),
  z.object({ path: ConfinedPath }),
]);

const ACTION_SCHEMAS = {
  "appearance.get": z.object({ udid: Device }),
  "appearance.set": z.object({ udid: Device, value: z.enum(APPEARANCES) }),
  "location.set": z.object({ udid: Device, lat: Coordinate, lng: Coordinate }),
  "location.clear": z.object({ udid: Device }),
  "home.springboard": z.object({ udid: Device }),
  "home.watch": z.object({ udid: Device.optional() }),
  rotate: z.object({ udid: Device, value: Token }),
  // udid is not part of the invocation; it is here so the session event log can file the press.
  button: z.object({ value: Token, udid: Device.optional() }),
  "server.detach": z.object({
    udid: Device.optional(),
    port: z.string().regex(/^[0-9]{1,5}$/).optional(),
  }),
  "server.kill": z.object({}),
  "camera.listWebcams": z.object({}),
  // The union also makes the target required for "file" and optional for the rest.
  "camera.switch": z.discriminatedUnion("source", [
    z.object({ udid: Device, source: z.literal("file"), target: ConfinedPath }),
    z.object({ udid: Device, source: z.literal("webcam"), target: Argument.optional() }),
    z.object({ udid: Device, source: z.literal("placeholder") }),
  ]),
  "camera.inject": z.discriminatedUnion("source", [
    z.object({
      udid: Device,
      bundleId: BundleId,
      mirror: z.enum(MIRROR_VALUES),
      source: z.literal("file"),
      target: ConfinedPath,
    }),
    z.object({
      udid: Device,
      bundleId: BundleId,
      mirror: z.enum(MIRROR_VALUES),
      source: z.literal("webcam"),
      target: Argument.optional(),
    }),
    z.object({
      udid: Device,
      bundleId: BundleId,
      mirror: z.enum(MIRROR_VALUES),
      source: z.literal("placeholder"),
    }),
  ]),
  "camera.mirror": z.object({ udid: Device, value: z.enum(MIRROR_VALUES) }),
  "camera.stopWebcam": z.object({ udid: Device }),
  "permissions.set": z.object({
    udid: Device,
    bundleId: BundleId,
    action: z.enum(PERMISSION_ACTIONS),
    service: Token,
  }),
  "permissions.resetAll": z.object({ udid: Device, bundleId: BundleId }),
  "app.container": z.object({ udid: Device, bundleId: BundleId }),
  "app.infoPlist": z.object({ path: ConfinedPath }),
  "app.install": z.object({ udid: Device }).and(FileSource),
  "app.iconPath": z.object({ appPath: ConfinedPath, candidates: z.array(FileName).min(1).max(32) }),
  "media.add": z.object({ udid: Device }).and(FileSource),
  reveal: z.object({ path: ConfinedPath }),
  "file.readBase64": z.object({ path: ConfinedPath }),
  "screenshot.capture": z.object({ udid: Device, fileName: UploadId }),
  "screenshot.thumbnail": z.object({ path: ConfinedPath }),
  "upload.append": z.object({
    uploadId: UploadId,
    // Bounded here rather than trusting the socket's cap: a host may supply its own transport.
    data: z.base64().min(1).max(MAX_UPLOAD_CHUNK_BASE64),
    first: z.boolean().optional(),
  }),
  "upload.remove": z.object({ uploadId: UploadId }),
} as const;

type HostActionName = keyof typeof ACTION_SCHEMAS;

function isHostActionName(action: string): action is HostActionName {
  return Object.hasOwn(ACTION_SCHEMAS, action);
}

type ParamsFor<A extends HostActionName> = z.infer<(typeof ACTION_SCHEMAS)[A]>;

function parseParams<A extends HostActionName>(action: A, raw: unknown): ParamsFor<A> {
  const result = ACTION_SCHEMAS[action].safeParse(raw ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.join(".");
    throw new InvalidHostActionError(
      `${action}: ${field ? `${field} ` : ""}${issue?.message ?? "invalid params"}`,
    );
  }
  return result.data as ParamsFor<A>;
}

/** How the serve-sim CLI is invoked; a .ts/.js entrypoint needs its runtime in front. */
function serveSimInvocation(binPath: string, args: string[]): Invocation {
  if (/\.ts$/.test(binPath)) return { file: "bun", args: [binPath, ...args] };
  if (/\.js$/.test(binPath)) return { file: "node", args: [binPath, ...args] };
  return { file: binPath, args };
}

function buildInvocation(action: HostActionName, raw: unknown, binPath: string): Invocation {
  const serveSim = (args: string[]): Invocation => serveSimInvocation(binPath, args);
  const simctl = (args: string[]): Invocation => ({ file: "xcrun", args: ["simctl", ...args] });

  switch (action) {
    case "appearance.get": {
      const p = parseParams(action, raw);
      return simctl(["ui", p.udid, "appearance"]);
    }
    case "appearance.set": {
      const p = parseParams(action, raw);
      return simctl(["ui", p.udid, "appearance", p.value]);
    }
    case "location.set": {
      const p = parseParams(action, raw);
      return simctl(["location", p.udid, "set", `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`]);
    }
    case "location.clear": {
      const p = parseParams(action, raw);
      return simctl(["location", p.udid, "clear"]);
    }
    case "home.springboard": {
      const p = parseParams(action, raw);
      return simctl(["launch", p.udid, "com.apple.springboard"]);
    }
    case "home.watch":
      parseParams(action, raw);
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
    case "rotate": {
      const p = parseParams(action, raw);
      return serveSim(["rotate", p.value, "-d", p.udid]);
    }
    case "button": {
      const p = parseParams(action, raw);
      return serveSim(["button", p.value]);
    }
    case "server.detach": {
      const p = parseParams(action, raw);
      return serveSim([
        "--detach",
        ...(p.udid ? [p.udid] : []),
        ...(p.port ? ["--port", p.port] : []),
      ]);
    }
    case "server.kill":
      return serveSim(["--kill"]);
    case "camera.listWebcams":
      return serveSim(["camera", "--list-webcams"]);
    case "camera.switch": {
      const p = parseParams(action, raw);
      const target = "target" in p ? p.target : undefined;
      return serveSim([
        "camera",
        "switch",
        p.source,
        ...(target ? [target] : []),
        "-d",
        p.udid,
        "--quiet",
      ]);
    }
    case "camera.inject": {
      const p = parseParams(action, raw);
      const args = ["camera", p.bundleId, "-d", p.udid, "--quiet"];
      if (p.source === "file") args.push("--file", p.target);
      else if (p.source === "webcam") args.push("--webcam", ...(p.target ? [p.target] : []));
      args.push("--mirror", p.mirror);
      return serveSim(args);
    }
    case "camera.mirror": {
      const p = parseParams(action, raw);
      return serveSim(["camera", "mirror", p.value, "-d", p.udid, "--quiet"]);
    }
    case "camera.stopWebcam": {
      const p = parseParams(action, raw);
      return serveSim(["camera", "--stop-webcam", "-d", p.udid]);
    }
    case "permissions.set": {
      const p = parseParams(action, raw);
      return serveSim(["permissions", p.action, p.service, p.bundleId, "-d", p.udid]);
    }
    case "permissions.resetAll": {
      const p = parseParams(action, raw);
      return serveSim(["permissions", "reset", "all", p.bundleId, "-d", p.udid]);
    }
    case "app.container": {
      const p = parseParams(action, raw);
      return simctl(["get_app_container", p.udid, p.bundleId, "app"]);
    }
    case "app.infoPlist": {
      const p = parseParams(action, raw);
      return { file: "plutil", args: ["-convert", "json", "-o", "-", p.path] };
    }
    case "app.install": {
      const p = parseParams(action, raw);
      return simctl(["install", p.udid, fileSourcePath(p)]);
    }
    case "media.add": {
      const p = parseParams(action, raw);
      return simctl(["addmedia", p.udid, fileSourcePath(p)]);
    }
    case "reveal": {
      const p = parseParams(action, raw);
      return { file: "open", args: ["-R", p.path] };
    }
    default:
      // Reaching here means an ACTION_SCHEMAS entry has no home in either dispatcher.
      throw new InvalidHostActionError(`unknown action ${String(action)}`);
  }
}

function fileSourcePath(p: { uploadId: string } | { path: string }): string {
  return "uploadId" in p ? join(UPLOAD_DIR, p.uploadId) : p.path;
}

/** Child output is useful, but a stack trace prints the operator's checkout. Keep the message. */
function redactHostPaths(text: string): string {
  if (!text) return text;
  return text.split(homedir()).join("~").replace(/\/(?:private\/)?var\/folders\/\S+/g, "<tmp>");
}

function runInvocation({ file, args }: Invocation): Promise<HostActionResult> {
  return new Promise<HostActionResult>((resolve) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      resolve({
        stdout: stdout.toString(),
        // Never `err.message`: it embeds the absolute binary path and the full argv.
        stderr:
          redactHostPaths(stderr.toString()) ||
          (typeof code === "string" ? `spawn failed (${code})` : ""),
        exitCode: err ? (typeof code === "number" ? code : 1) : 0,
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
  action: HostActionName,
  raw: unknown,
): Promise<HostActionResult | null> {
  switch (action) {
    case "upload.append": {
      const p = parseParams(action, raw);
      const target = join(UPLOAD_DIR, p.uploadId);
      const chunk = Buffer.from(p.data, "base64");
      return await queueUploadAsync(async () => {
      await ensureUploadDirAsync();
      // Every chunk: appendFile creates the file too, so omitting `first` would skip the ceiling.
      if ((await pruneUploadsAsync()) + chunk.length > MAX_UPLOAD_DIR_BYTES) {
        return {
          stdout: "",
          stderr:
            `The upload staging area is full (over ${Math.floor(MAX_UPLOAD_DIR_BYTES / 1024 ** 3)}GB). ` +
            `Uploads are removed after ${MAX_UPLOAD_AGE_MS / 3_600_000} hours; retry once the ` +
            "transfers in flight finish.",
          exitCode: 1,
        };
      }
      if (p.first === true) await writeFile(target, chunk);
      else await appendFile(target, chunk);
      return ok(target);
      });
    }
    case "upload.remove": {
      const p = parseParams(action, raw);
      await rm(join(UPLOAD_DIR, p.uploadId), { force: true });
      return ok();
    }
    case "app.iconPath": {
      const p = parseParams(action, raw);
      for (const candidate of p.candidates) {
        const full = join(p.appPath, candidate);
        try {
          if ((await stat(full)).isFile()) return ok(full);
        } catch {
          // A missing candidate is the normal case; try the next name.
        }
      }
      return { stdout: "", stderr: "no icon found", exitCode: 1 };
    }
    case "file.readBase64": {
      const p = parseParams(action, raw);
      return await runInvocation({ file: "base64", args: ["-i", p.path] });
    }
    // The page names the file but never the directory.
    case "screenshot.capture": {
      const p = parseParams(action, raw);
      const target = join(homedir(), "Desktop", p.fileName);
      // Without a ceiling a link holder can loop screenshots until the disk is full.
      if (await desktopScreenshotBudgetExceededAsync()) {
        return {
          stdout: "",
          stderr:
            "Too many serve-sim screenshots are already on the Desktop. Move or delete some, " +
            "then take another.",
          exitCode: 1,
        };
      }
      const result = await runInvocation({
        file: "xcrun",
        args: ["simctl", "io", p.udid, "screenshot", target],
      });
      return result.exitCode === 0 ? ok(target) : result;
    }
    // Scratch, so it is staged away from its source and removed even if sips fails part-way.
    case "screenshot.thumbnail": {
      const p = parseParams(action, raw);
      const thumb = join(UPLOAD_DIR, `thumb-${randomUUID()}.png`);
      await ensureUploadDirAsync();
      try {
        const sips = await runInvocation({
          file: "sips",
          args: ["-Z", "320", p.path, "--out", thumb],
        });
        if (sips.exitCode !== 0) return sips;
        return await runInvocation({ file: "base64", args: ["-i", thumb] });
      } finally {
        await rm(thumb, { force: true });
      }
    }
    default:
      return null;
  }
}

export async function runHostActionAsync(
  msg: HostActionRequest,
  binPath: string,
): Promise<HostActionResult> {
  if (typeof msg.action !== "string" || !isHostActionName(msg.action)) {
    throw new InvalidHostActionError(`unknown action ${String(msg.action)}`);
  }
  const inProcess = await runInProcessAsync(msg.action, msg.params);
  if (inProcess) return inProcess;
  return await runInvocation(buildInvocation(msg.action, msg.params, binPath));
}
