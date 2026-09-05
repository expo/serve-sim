import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

import { runHostActionAsync } from "../host-actions";

// Every CLI-backed action builds an argument vector by hand, and a wrong flag or a swapped
// positional would still exit 0 against a real tool. These shims report the argv they were handed,
// so the vector itself is asserted rather than the fact that something ran.
const SHIM = `#!/bin/sh
{
  printf '%s\\n' "$(basename "$0")"
  for a in "$@"; do printf '%s\\n' "$a"; done
} | tee -a "\${SERVE_SIM_ARGV_LOG:-/dev/null}"
`;

const UDID = "404F2659-7202-4450-8465-912BD2AB744B";
const BUNDLE = "com.example.app";
// Under an allowed root so ConfinedPath accepts it; never created, so nothing is written. The
// server canonicalizes the directory, so the expected argv uses the real path, not the lexical one.
const UPLOADS = join(tmpdir(), "serve-sim-uploads");
mkdirSync(UPLOADS, { recursive: true });
const CONFINED = join(realpathSync(UPLOADS), "serve-sim-argv-fixture.png");

let shimDir: string;
let serveSimBin: string;
let argvLog: string;
let originalPath: string | undefined;

beforeAll(() => {
  shimDir = mkdtempSync(join(tmpdir(), "serve-sim-argv-"));
  for (const name of ["xcrun", "plutil", "open", "osascript", "sips", "base64", "serve-sim"]) {
    const p = join(shimDir, name);
    writeFileSync(p, SHIM);
    chmodSync(p, 0o755);
  }
  serveSimBin = join(shimDir, "serve-sim");
  argvLog = join(shimDir, "argv.log");
  process.env.SERVE_SIM_ARGV_LOG = argvLog;
  originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
});

afterAll(() => {
  delete process.env.SERVE_SIM_ARGV_LOG;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(shimDir, { recursive: true, force: true });
});

// Actions that replace stdout with their own result still leave their argv in the shim log.
function loggedArgv(): string[][] {
  const raw = readFileSync(argvLog, "utf8").trimEnd();
  if (!raw) return [];
  const lines = raw.split("\n");
  const runs: string[][] = [];
  for (const line of lines) {
    if (["xcrun", "plutil", "open", "osascript", "sips", "base64", "serve-sim"].includes(line)) {
      runs.push([line]);
    } else {
      runs[runs.length - 1]?.push(line);
    }
  }
  return runs;
}

async function argv(action: string, params?: Record<string, unknown>): Promise<string[]> {
  const result = await runHostActionAsync(
    params === undefined ? { action } : { action, params },
    serveSimBin,
  );
  expect(result.exitCode).toBe(0);
  return result.stdout.trimEnd().split("\n");
}

describe("simctl-backed actions", () => {
  it("builds appearance get and set", async () => {
    expect(await argv("appearance.get", { udid: UDID })).toEqual([
      "xcrun", "simctl", "ui", UDID, "appearance",
    ]);
    expect(await argv("appearance.set", { udid: UDID, value: "dark" })).toEqual([
      "xcrun", "simctl", "ui", UDID, "appearance", "dark",
    ]);
  });

  it("builds location set and clear", async () => {
    expect(await argv("location.set", { udid: UDID, lat: 37.3349, lng: -122.009 })).toEqual([
      "xcrun", "simctl", "location", UDID, "set", "37.3349000,-122.0090000",
    ]);
    expect(await argv("location.clear", { udid: UDID })).toEqual([
      "xcrun", "simctl", "location", UDID, "clear",
    ]);
  });

  it("builds home springboard", async () => {
    expect(await argv("home.springboard", { udid: UDID })).toEqual([
      "xcrun", "simctl", "launch", UDID, "com.apple.springboard",
    ]);
  });

  // The trailing "app" selects the bundle container rather than the data container.
  it("builds app container", async () => {
    expect(await argv("app.container", { udid: UDID, bundleId: BUNDLE })).toEqual([
      "xcrun", "simctl", "get_app_container", UDID, BUNDLE, "app",
    ]);
  });

  it("builds app install and media add from a path", async () => {
    expect(await argv("app.install", { udid: UDID, path: CONFINED })).toEqual([
      "xcrun", "simctl", "install", UDID, CONFINED,
    ]);
    expect(await argv("media.add", { udid: UDID, path: CONFINED })).toEqual([
      "xcrun", "simctl", "addmedia", UDID, CONFINED,
    ]);
  });

  it("resolves a staged upload into the install path", async () => {
    const out = await argv("app.install", { udid: UDID, uploadId: "staged.ipa" });
    expect(out.slice(0, 4)).toEqual(["xcrun", "simctl", "install", UDID]);
    expect(out[4]).toMatch(/serve-sim-uploads\/staged\.ipa$/);
  });
});

describe("other host tools", () => {
  // -o - keeps plutil on stdout so it never rewrites the app's own Info.plist in place.
  it("builds the info plist read", async () => {
    expect(await argv("app.infoPlist", { path: CONFINED })).toEqual([
      "plutil", "-convert", "json", "-o", "-", CONFINED,
    ]);
  });

  it("builds reveal", async () => {
    expect(await argv("reveal", { path: CONFINED })).toEqual(["open", "-R", CONFINED]);
  });

  it("builds the watch home press as three -e scripts", async () => {
    const out = await argv("home.watch", { udid: UDID });
    expect(out[0]).toBe("osascript");
    expect(out.filter((a) => a === "-e")).toHaveLength(3);
    expect(out[out.length - 1]).toContain('click menu item "Home"');
  });
});

describe("in-process actions that still shell out", () => {
  it("captures to the Desktop and echoes the written path", async () => {
    const result = await runHostActionAsync(
      { action: "screenshot.capture", params: { udid: UDID, fileName: "serve-sim-screenshot-shot.png" } },
      serveSimBin,
    );
    const target = join(homedir(), "Desktop", "serve-sim-screenshot-shot.png");
    expect(result.exitCode).toBe(0);
    // The toast's reveal action reads this path back, so it has to be the file simctl was given.
    expect(result.stdout.trim()).toBe(target);
    expect(loggedArgv().at(-1)).toEqual(["xcrun", "simctl", "io", UDID, "screenshot", target]);
  });

  it("sizes a thumbnail and reads it back as base64", async () => {
    await runHostActionAsync({ action: "screenshot.thumbnail", params: { path: CONFINED } }, serveSimBin);
    const runs = loggedArgv();
    const sips = runs.find((r) => r[0] === "sips")!;
    expect(sips.slice(0, 5)).toEqual(["sips", "-Z", "320", CONFINED, "--out"]);
    expect(sips[5]).toMatch(/serve-sim-uploads\/thumb-[0-9a-f-]+\.png$/);
    // The scratch thumbnail is read back and then removed, whatever sips did.
    expect(runs.at(-1)?.slice(0, 2)).toEqual(["base64", "-i"]);
    expect(existsSync(sips[5]!)).toBe(false);
  });

  it("returns the first icon candidate that exists", async () => {
    const appPath = realpathSync(mkdtempSync(join(UPLOADS, "serve-sim-icon-")));
    try {
      writeFileSync(join(appPath, "Icon@2x.png"), "");
      const found = await runHostActionAsync(
        { action: "app.iconPath", params: { appPath, candidates: ["Icon@3x.png", "Icon@2x.png"] } },
        serveSimBin,
      );
      expect(found.exitCode).toBe(0);
      expect(found.stdout.trim()).toBe(join(appPath, "Icon@2x.png"));

      const missing = await runHostActionAsync(
        { action: "app.iconPath", params: { appPath, candidates: ["Icon@3x.png"] } },
        serveSimBin,
      );
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toBe("no icon found");
    } finally {
      rmSync(appPath, { recursive: true, force: true });
    }
  });
});

describe("serve-sim-backed actions", () => {
  it("builds rotate and button", async () => {
    expect(await argv("rotate", { udid: UDID, value: "landscape" })).toEqual([
      "serve-sim", "rotate", "landscape", "-d", UDID,
    ]);
    expect(await argv("button", { value: "home", udid: UDID })).toEqual([
      "serve-sim", "button", "home", "-d", UDID,
    ]);
    expect(await argv("button", { value: "home" })).toEqual(["serve-sim", "button", "home"]);
  });

  it("builds server detach and kill", async () => {
    expect(await argv("server.detach", { udid: UDID, port: "3100" })).toEqual([
      "serve-sim", "--detach", UDID, "--port", "3100",
    ]);
    expect(await argv("server.detach", {})).toEqual(["serve-sim", "--detach"]);
    expect(await argv("server.kill", {})).toEqual(["serve-sim", "--kill"]);
  });

  it("builds the camera listing, mirror and stop", async () => {
    expect(await argv("camera.listWebcams", {})).toEqual([
      "serve-sim", "camera", "--list-webcams",
    ]);
    expect(await argv("camera.mirror", { udid: UDID, value: "on" })).toEqual([
      "serve-sim", "camera", "mirror", "on", "-d", UDID, "--quiet",
    ]);
    expect(await argv("camera.stopWebcam", { udid: UDID })).toEqual([
      "serve-sim", "camera", "--stop-webcam", "-d", UDID,
    ]);
  });

  it("builds camera switch for each source", async () => {
    expect(await argv("camera.switch", { udid: UDID, source: "placeholder" })).toEqual([
      "serve-sim", "camera", "switch", "placeholder", "-d", UDID, "--quiet",
    ]);
    expect(await argv("camera.switch", { udid: UDID, source: "file", target: CONFINED })).toEqual([
      "serve-sim", "camera", "switch", "file", CONFINED, "-d", UDID, "--quiet",
    ]);
    expect(
      await argv("camera.switch", { udid: UDID, source: "webcam", target: "Studio Display Camera" }),
    ).toEqual([
      "serve-sim", "camera", "switch", "webcam", "Studio Display Camera", "-d", UDID, "--quiet",
    ]);
  });

  it("builds camera inject for each source", async () => {
    expect(
      await argv("camera.inject", {
        udid: UDID, bundleId: BUNDLE, mirror: "off", source: "file", target: CONFINED,
      }),
    ).toEqual([
      "serve-sim", "camera", BUNDLE, "-d", UDID, "--quiet", "--file", CONFINED, "--mirror", "off",
    ]);
    // A webcam with no name leaves --webcam bare, and the CLI reads the next "-" token as "no name".
    expect(
      await argv("camera.inject", {
        udid: UDID, bundleId: BUNDLE, mirror: "on", source: "webcam",
      }),
    ).toEqual([
      "serve-sim", "camera", BUNDLE, "-d", UDID, "--quiet", "--webcam", "--mirror", "on",
    ]);
    expect(
      await argv("camera.inject", {
        udid: UDID, bundleId: BUNDLE, mirror: "on", source: "placeholder",
      }),
    ).toEqual(["serve-sim", "camera", BUNDLE, "-d", UDID, "--quiet", "--mirror", "on"]);
  });

  it("builds the permission actions", async () => {
    expect(
      await argv("permissions.set", {
        udid: UDID, bundleId: BUNDLE, action: "grant", service: "camera",
      }),
    ).toEqual(["serve-sim", "permissions", "grant", "camera", BUNDLE, "-d", UDID]);
    expect(await argv("permissions.resetAll", { udid: UDID, bundleId: BUNDLE })).toEqual([
      "serve-sim", "permissions", "reset", "all", BUNDLE, "-d", UDID,
    ]);
  });
});
