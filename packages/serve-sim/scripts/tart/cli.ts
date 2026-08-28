#!/usr/bin/env bun
import { SSH_OPTS, loadTartConfig, setupGuest, TartGuest } from "./guest";
import { bootSim } from "./sim";
import { GUEST_PKG, GUEST_SIMPB, resolveTestFiles, stageGuest, testOnce } from "./stage";
import { runDev } from "./dev";

const USAGE = `bun run tart <command>

  setup   create the guest user and copy bun (once per VM)
  up      start the VM (no-op if already running)
  boot    boot an iPhone 17 on the guest
  stage   pack host src onto the guest
  test    run bun test on the guest
  dev     run serve-sim on the guest, print http://localhost:3200
  ssh     ssh to the guest (remaining args are a remote command)

SSH as TART_USER (default expo), not tart exec as admin.

Env: TART_VM=tahoe-xcode TART_USER=expo TART_SHARE_NAME=serve-sim PORT=3200
`;

async function prepare(guest: TartGuest): Promise<void> {
  await guest.ensureRunning();
  try {
    await guest.waitSsh(20);
  } catch {
    console.log("guest user not ready; running setup");
    await setupGuest(guest);
  }
  await guest.assertShare();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "test";
  const rest = argv.slice(1);
  const config = loadTartConfig();
  const guest = new TartGuest(config);

  switch (command) {
    case "help":
    case "-h":
    case "--help":
      console.log(USAGE);
      return;
    case "setup":
      await guest.ensureRunning();
      await setupGuest(guest);
      return;
    case "up":
      await guest.ensureRunning();
      await guest.waitSsh();
      console.log(`${config.user}@${guest.ip}`);
      return;
    case "boot":
      await prepare(guest);
      await bootSim(guest);
      return;
    case "stage":
      await prepare(guest);
      await stageGuest(guest);
      console.log(`staged ${GUEST_PKG} and ${GUEST_SIMPB}`);
      return;
    case "test": {
      await prepare(guest);
      const files = resolveTestFiles(config.pkgDir, rest);
      if (!files.length) {
        console.error("no test files. Pass paths after tart test.");
        process.exit(2);
      }
      const udid = await bootSim(guest);
      process.exit(await testOnce(guest, files, udid));
    }
    case "dev": {
      await prepare(guest);
      await runDev(guest, await bootSim(guest));
      return;
    }
    case "ssh": {
      await prepare(guest);
      if (!rest.length) {
        const proc = Bun.spawn(["ssh", ...SSH_OPTS, guest.sshTarget()], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        process.exit(await proc.exited);
      }
      process.exit(await guest.sshInherit(rest.join(" ")));
    }
    default:
      console.error(USAGE);
      process.exit(2);
  }
}

await main();
