import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { dirnameOf } from "./runtime";

const here = dirnameOf(import.meta.url);

function locate(candidates: string[]): string | null {
  return candidates.find(existsSync) ?? null;
}

export function locateCameraDylib(): string | null {
  return locate([
    join(dirname(process.execPath), "simcam", "libSimCameraInjector.dylib"),
    join(here, "..", "dist", "simcam", "libSimCameraInjector.dylib"),
    join(here, "..", "Sources", "SimCameraInjector", "build", "libSimCameraInjector.dylib"),
  ]);
}

export function buildCameraDylib(): string {
  const buildScript = join(here, "..", "Sources", "SimCameraInjector", "build.sh");
  if (!existsSync(buildScript)) {
    throw new Error("SimCameraInjector source not found. Reinstall from a recent release.");
  }
  console.error("[serve-sim] building libSimCameraInjector.dylib (one-time)…");
  execSync(`bash "${buildScript}"`, { stdio: "inherit" });
  const dylib = locateCameraDylib();
  if (!dylib) throw new Error("Build succeeded but camera dylib was not found.");
  return dylib;
}

function locateFpsDylib(): string | null {
  return locate([
    join(dirname(process.execPath), "simfps", "libSimFpsProbe.dylib"),
    join(here, "..", "dist", "simfps", "libSimFpsProbe.dylib"),
  ]);
}

function buildFpsDylib(): string {
  const buildScript = join(here, "..", "Sources", "SimFpsProbe", "build.sh");
  if (!existsSync(buildScript)) {
    throw new Error("SimFpsProbe source not found. Reinstall from a recent release.");
  }
  console.error("[serve-sim] building libSimFpsProbe.dylib (one-time)…");
  execSync(`bash "${buildScript}"`, { stdio: "inherit" });
  const dylib = locateFpsDylib();
  if (!dylib) throw new Error("Build succeeded but FPS dylib was not found.");
  return dylib;
}

export function fpsDylib(): string {
  return locateFpsDylib() ?? buildFpsDylib();
}

export function cameraShmName(udid: string): string {
  const short = createHash("sha1").update(udid).digest("hex").slice(0, 8);
  return `/serve-sim-cam-${short}`;
}

export function injectedAppEnvironment({
  fps,
  camera,
}: {
  fps: { dylib: string; shmName: string };
  camera?: { dylib: string; shmName: string; mirror?: string };
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: camera
      ? `${fps.dylib}:${camera.dylib}`
      : fps.dylib,
    SIMCTL_CHILD_SERVE_SIM_FPS_SHM: fps.shmName,
    ...(camera
      ? {
          SIMCTL_CHILD_SIMCAM_SHM_NAME: camera.shmName,
          ...(camera.mirror ? { SIMCTL_CHILD_SIMCAM_MIRROR_MODE: camera.mirror } : {}),
        }
      : {}),
  };
}
