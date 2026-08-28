import { existsSync } from "fs";
import { join } from "path";
import { GUEST_PATH, guestPkgPath, type TartGuest } from "./guest";
import { warmSafari } from "./sim";

export const GUEST_PKG = "/tmp/serve-sim-pkg";
export const GUEST_SIMPB = "/tmp/simpb";

function simpbFiles(pkgDir: string): string[] {
  const dir = join(pkgDir, "dist", "simpb");
  return [
    "libSimPasteboardReader.dylib",
    "libSimPasteboardReaderUI.dylib",
    "serve-sim-pasteboard",
  ]
    .map((name) => join(dir, name))
    .filter((path) => existsSync(path));
}

export async function stageGuest(guest: TartGuest): Promise<void> {
  const { pkgDir } = guest.config;
  await guest.ssh(`mkdir -p ${GUEST_SIMPB} ${GUEST_PKG}`);

  const binaries = simpbFiles(pkgDir);
  if (binaries.length) await guest.scp(binaries, `${GUEST_SIMPB}/`);

  if (existsSync(join(pkgDir, "dist", "simpb", "PasteboardFixture.app", "PasteboardFixture"))) {
    await guest.tarTo(join(pkgDir, "dist", "simpb"), ["PasteboardFixture.app"], GUEST_SIMPB);
  }

  const extras = ["bun.lock", "bun.lockb", "dev.ts", "dist"].filter((name) => existsSync(join(pkgDir, name)));
  await guest.tarTo(pkgDir, ["src", "package.json", ...extras], GUEST_PKG);
}

export async function warmFixture(guest: TartGuest, udid: string): Promise<void> {
  const quoted = JSON.stringify(udid);
  const code = await guest.sshInherit(`${GUEST_PATH}
set -euo pipefail
if [[ ! -d ${GUEST_SIMPB}/PasteboardFixture.app ]]; then
  exit 0
fi
xcrun simctl install ${quoted} ${GUEST_SIMPB}/PasteboardFixture.app >/dev/null
xcrun simctl privacy ${quoted} grant pasteboard dev.expo.serve-sim.pasteboard-fixture >/dev/null
`);
  if (code !== 0) throw new Error("failed to install the pasteboard fixture on the guest");
}

export async function runGuestTests(guest: TartGuest, files: string[]): Promise<number> {
  const share = JSON.stringify(guestPkgPath(guest.config));
  const quoted = files.map((file) => JSON.stringify(file)).join(" ");
  return guest.sshInherit(`${GUEST_PATH}
set -euo pipefail
chmod -R 755 ${GUEST_SIMPB}
xattr -cr ${GUEST_SIMPB} 2>/dev/null || true
export SERVE_SIM_SIMPB_DIR=${GUEST_SIMPB}
SHARE=${share}
if [[ -d "$SHARE/node_modules" ]]; then
  ln -sfn "$SHARE/node_modules" ${GUEST_PKG}/node_modules
else
  cd ${GUEST_PKG} && bun install
fi
if [[ -d "$SHARE/dist" ]]; then
  ln -sfn "$SHARE/dist" ${GUEST_PKG}/dist
fi
cd ${GUEST_PKG}
echo "user=$(whoami) console=$(stat -f %Su /dev/console) pwd=$PWD simpb=$SERVE_SIM_SIMPB_DIR"
exec bun test --max-concurrency=1 ${quoted}
`);
}

export async function testOnce(guest: TartGuest, files: string[], udid: string): Promise<number> {
  await stageGuest(guest);
  await warmSafari(guest, udid);
  await warmFixture(guest, udid);
  return runGuestTests(guest, files);
}
