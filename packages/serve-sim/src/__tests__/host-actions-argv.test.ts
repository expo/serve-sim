import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

import { runHostActionAsync } from "../host-actions";

// Every CLI-backed action builds an argument vector by hand, and a wrong flag or a swapped
// positional would still exit 0 against a real tool. These shims report the argv they were handed,
// so the vector itself is asserted rather than the fact that something ran.
const SHIM = `#!/bin/sh
printf '%s\\n' "$(basename "$0")"
for a in "$@"; do printf '%s\\n' "$a"; done
`;

const UDID = "404F2659-7202-4450-8465-912BD2AB744B";
const BUNDLE = "com.example.app";
// Under an allowed root so ConfinedPath accepts it; never created, so nothing is written.
const CONFINED = join(homedir(), "Desktop", "serve-sim-argv-fixture.png");

let shimDir: string;
let serveSimBin: string;
let originalPath: string | undefined;

beforeAll(() => {
  shimDir = mkdtempSync(join(tmpdir(), "serve-sim-argv-"));
  for (const name of ["xcrun", "plutil", "open", "osascript", "serve-sim"]) {
    const p = join(shimDir, name);
    writeFileSync(p, SHIM);
    chmodSync(p, 0o755);
  }
  serveSimBin = join(shimDir, "serve-sim");
  originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
});

afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(shimDir, { recursive: true, force: true });
});

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

  // Coordinates are formatted to 7 decimals and sent as one comma-joined positional.
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

describe("serve-sim-backed actions", () => {
  it("builds rotate and button", async () => {
    expect(await argv("rotate", { udid: UDID, value: "landscape" })).toEqual([
      "serve-sim", "rotate", "landscape", "-d", UDID,
    ]);
    // The udid is recorded for the event log but is not part of the press invocation.
    expect(await argv("button", { value: "home", udid: UDID })).toEqual([
      "serve-sim", "button", "home",
    ]);
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
