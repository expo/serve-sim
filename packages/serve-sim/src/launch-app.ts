import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const URL_SCHEME_APPROVAL_DOMAIN = "com.apple.launchservices.schemeapproval";
const URL_SCHEME_APPROVAL_KEY_PREFIX = "com.apple.CoreSimulator.CoreSimulatorBridge-->";

async function preapproveUrlSchemeAsync(
  udid: string,
  bundleId: string,
  openUrl: string,
): Promise<void> {
  const scheme = new URL(openUrl).protocol.slice(0, -1);
  if (scheme === "http" || scheme === "https") return;
  try {
    await execFileAsync(
      "xcrun",
      [
        "simctl", "spawn", udid, "defaults", "write",
        URL_SCHEME_APPROVAL_DOMAIN,
        `${URL_SCHEME_APPROVAL_KEY_PREFIX}${scheme}`,
        "-string", bundleId,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
  } catch {
    console.error(
      `Could not pre-approve the ${scheme}: URL scheme for ${bundleId}. Opening the URL anyway; ` +
        `the Simulator may ask you to confirm it.`,
    );
  }
}

export async function launchAppAsync(
  udid: string,
  { bundleId, launchArgs, openUrl }: { bundleId: string; launchArgs: string[]; openUrl?: string },
): Promise<void> {
  // `simctl launch` only foregrounds an app that is already running, and drops
  // the arguments, so stop it first rather than report a launch that did not
  // take the arguments it was given. Exits non-zero when it was not running.
  await execFileAsync("xcrun", ["simctl", "terminate", udid, bundleId], {
    encoding: "utf8",
    timeout: 30_000,
  }).catch(() => undefined);

  await execFileAsync("xcrun", ["simctl", "launch", udid, bundleId, ...launchArgs], {
    encoding: "utf8",
    timeout: 30_000,
  });

  if (openUrl) {
    await preapproveUrlSchemeAsync(udid, bundleId, openUrl);
    await execFileAsync("xcrun", ["simctl", "openurl", udid, openUrl], {
      encoding: "utf8",
      timeout: 30_000,
    });
  }
}
