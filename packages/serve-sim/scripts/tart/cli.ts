#!/usr/bin/env bun
import { SSH_OPTS, loadTartConfig, setupGuest, TartGuest } from "./guest";
import { bootSim } from "./sim";
import { resolveTestFiles, stageGuest, testOnce } from "./stage";

const USAGE = `bun run tart <command>

  setup   create the non-console guest user and copy bun (once per VM)
  up      start the VM with the repo shared (no-op if already running)
  boot    boot an iPhone 17 on the guest
  stage   pack host src + dist/simpb onto the guest (EAS-shaped, not virtiofs)
  test    stage, warm, bun test on the guest as the non-console user
  ssh     ssh to the guest (remaining args are a remote command)

Tests always SSH as TART_USER (default expo). tart exec as admin still has
Aqua, so it is not an EAS-shaped pasteboard host.

Env: TART_VM=tahoe-xcode TART_USER=expo TART_SHARE_NAME=serve-sim
`;

async function prepare(guest: TartGuest): Promise<void> {
  await guest.ensureRunning();
  await guest.waitSsh();
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
      console.log("staged /tmp/serve-sim-pkg and /tmp/simpb");
      return;
    case "test": {
      await prepare(guest);
      await bootSim(guest);
      process.exit(await testOnce(guest, resolveTestFiles(config.pkgDir, rest)));
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
