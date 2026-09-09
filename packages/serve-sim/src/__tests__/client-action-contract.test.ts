import { afterAll, describe, expect, it } from "bun:test";

import { mkdirSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { InvalidHostActionError, runHostActionAsync } from "../host-actions";
import { getPortHolders } from "../ports";

const BIN = "true";
const UDID = "404F2659-7202-4450-8465-912BD2AB744B";
const BUNDLE = "com.example.app";

// This one call has a real side effect: it starts a detached server that outlives the request.
const DETACH_PORT = "3100";

const UPLOADS = join(tmpdir(), "serve-sim-uploads");
mkdirSync(UPLOADS, { recursive: true });
const STAGED = join(realpathSync(UPLOADS), "contract-fixture.bin");

/**
 * The params each migrated tool actually builds, fed straight to the server's validator.
 *
 * The tools themselves are barely covered, and a schema that rejects a shape a tool sends fails at
 * runtime with nothing to catch it. These are the literal call sites, so a tightened schema that
 * no longer accepts one of them fails here instead of in the preview.
 */
const CALLS: Array<[string, string, Record<string, unknown> | undefined]> = [
  // camera-tool.tsx
  ["camera-tool", "camera.listWebcams", undefined],
  ["camera-tool", "camera.switch", { source: "placeholder", udid: UDID }],
  ["camera-tool", "camera.switch", { source: "webcam", target: "MacBook Pro Camera", udid: UDID }],
  ["camera-tool", "camera.switch", { source: "file", target: STAGED, udid: UDID }],
  ["camera-tool", "camera.inject", { bundleId: BUNDLE, udid: UDID, source: "placeholder", mirror: "on" }],
  ["camera-tool", "camera.inject", { bundleId: BUNDLE, udid: UDID, source: "file", target: STAGED, mirror: "off" }],
  ["camera-tool", "camera.mirror", { udid: UDID, value: "on" }],
  ["camera-tool", "camera.stopWebcam", { udid: UDID }],

  // location-emulation-tool.tsx — negative coordinates are the one value that starts with "-"
  ["location-tool", "location.set", { udid: UDID, lat: 37.3349, lng: -122.009 }],
  ["location-tool", "location.set", { udid: UDID, lat: -33.8688, lng: 151.2093 }],
  ["location-tool", "location.clear", { udid: UDID }],

  // app-permissions-tool.tsx — every service key the sidebar offers
  ...(["camera", "photos", "notifications", "location", "microphone", "contacts"] as const).map(
    (service) =>
      ["permissions-tool", "permissions.set", { action: "grant", service, bundleId: BUNDLE, udid: UDID }] as [
        string,
        string,
        Record<string, unknown>,
      ],
  ),
  ["permissions-tool", "permissions.resetAll", { bundleId: BUNDLE, udid: UDID }],

  // useSimStream.ts
  ["useSimStream", "server.detach", { udid: UDID }],
  ["useSimStream", "server.detach", { udid: UDID, port: DETACH_PORT }],
  ["useSimStream", "server.kill", {}],
  ["useSimStream", "button", { value: "home", udid: UDID }],
  ["useSimStream", "rotate", { udid: UDID, value: "landscape" }],

  // SimulatorToolbar.tsx
  ["toolbar", "screenshot.capture", { udid: UDID, fileName: "serve-sim-screenshot-1.png" }],
  ["toolbar", "appearance.get", { udid: UDID }],
  ["toolbar", "appearance.set", { udid: UDID, value: "dark" }],

  // app-icon.ts + use-screenshot-toast.tsx
  ["app-icon", "app.iconPath", { appPath: STAGED, candidates: ["Icon@2x.png", "Icon.png"] }],
  ["app-icon", "file.readBase64", { path: STAGED }],
  ["screenshot-toast", "screenshot.thumbnail", { fileName: "serve-sim-screenshot-1.png" }],
  ["screenshot-toast", "reveal", { screenshot: "serve-sim-screenshot-1.png" }],

  // app-detection-tool.tsx reveals a path inside the simulator container, not a named screenshot,
  // so both arms of the reveal union are call sites.
  ["app-detection", "reveal", { path: STAGED }],

  // drop.ts
  ["drop", "upload.append", { uploadId: "drop.ipa", data: btoa("x"), first: true }],
  ["drop", "upload.remove", { uploadId: "drop.ipa" }],
  ["drop", "app.install", { udid: UDID, uploadId: "drop.ipa" }],
  ["drop", "media.add", { udid: UDID, uploadId: "drop.mov" }],
];

describe("params the preview client sends are accepted by the server", () => {
  it.each(CALLS)("%s: %s", async (_tool, action, params) => {
    const call = runHostActionAsync(params === undefined ? { action } : { action, params }, BIN);
    // Execution may fail without a real simulator; only validation is under test here.
    await expect(call.catch((err: unknown) => {
      if (err instanceof InvalidHostActionError) throw err;
      return { stdout: "", stderr: "", exitCode: 0 };
    })).resolves.toBeDefined();
  });
});

// Without this the detached server holds its port for the rest of the session, and the next test
// that wants it fails with "Port 3100 is already in use" — in a later file, or a later run.
afterAll(() => {
  for (const pid of getPortHolders(Number(DETACH_PORT))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});
