// Trusting the capture proxy's root inside one simulator.
//
// The proxy owns the certificate authority and mints per-host leaves itself, so all that is left here
// is installing its root where the simulator's apps will accept it. `simctl keychain … add-root-cert`
// is scoped to a single device: nothing is added to the developer's own login keychain, and removing
// the simulator removes the trust with it.

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Deliberately no untrust.
//
// simctl offers `add-root-cert`, `add-cert` and `reset` — and nothing that removes one certificate. An
// earlier version called `reset` on teardown, which does not mean "reset the trusted roots": it clears the
// whole keychain, taking anything the app stored through expo-secure-store or Keychain Services, plus any
// Charles or Proxyman root the developer had installed. It ran automatically once the last panel viewer
// disconnected, so closing a browser tab destroyed the app's login state.
//
// What makes leaving the certificate safe is that it cannot be used. The authority is generated per
// session inside the proxy's own confdir, and that directory — private key included — is deleted when the
// session ends, and swept on the next start if the process was killed before it could. A trusted root
// whose private key no longer exists anywhere signs nothing.

/** Trust the proxy's root inside one booted simulator, so its apps accept intercepted connections. */
export async function trustCaInSimulator(udid: string, caPem: string): Promise<void> {
  // simctl reads the certificate from disk, so the PEM is staged in a directory of its own and removed
  // again once installed rather than left in a shared location.
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-ca-"));
  const certPath = join(dir, "capture-root.crt");
  try {
    writeFileSync(certPath, caPem);
    await execFileAsync("xcrun", ["simctl", "keychain", udid, "add-root-cert", certPath], {
      timeout: 20_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
