import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type RunCommand = (
  file: string,
  args: string[],
  timeout: number,
) => Promise<{ stdout: string }>;

interface InstallAndLaunchAppDeps {
  exists?: (path: string) => boolean;
  run?: RunCommand;
}

export async function installAndLaunchApp(
  udid: string,
  appPath: string,
  launch: (udid: string, bundleId: string) => Promise<number | null>,
  deps: InstallAndLaunchAppDeps = {},
): Promise<{ bundleId: string; pid: number | null }> {
  const path = resolve(appPath);
  const infoPlist = join(path, "Info.plist");
  if (!(deps.exists ?? existsSync)(infoPlist)) {
    throw new Error(`Invalid app bundle: ${infoPlist} was not found.`);
  }

  const run =
    deps.run ??
    (async (file, args, timeout) => {
      const { stdout } = await execFileAsync(file, args, {
        encoding: "utf8",
        timeout,
      });
      return { stdout };
    });
  const { stdout } = await run(
    "plutil",
    ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlist],
    5000,
  );
  const bundleId = stdout.trim();
  if (!bundleId) throw new Error(`Invalid app bundle: CFBundleIdentifier is missing.`);

  await run("xcrun", ["simctl", "install", udid, path], 120_000);
  return { bundleId, pid: await launch(udid, bundleId) };
}
