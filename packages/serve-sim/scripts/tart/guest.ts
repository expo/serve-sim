import { spawn } from "bun";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

export type TartConfig = {
  vm: string;
  user: string;
  shareName: string;
  repoDir: string;
  pkgDir: string;
};

export const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=8",
];

export function loadTartConfig(): TartConfig {
  const pkgDir = resolve(import.meta.dir, "../..");
  return {
    vm: process.env.TART_VM ?? "tahoe-xcode",
    user: process.env.TART_USER ?? "expo",
    shareName: process.env.TART_SHARE_NAME ?? "serve-sim",
    repoDir: resolve(pkgDir, "../.."),
    pkgDir,
  };
}

export function guestPkgPath(config: TartConfig): string {
  return `/Volumes/My Shared Files/${config.shareName}/packages/serve-sim`;
}

async function run(cmd: string[], opts?: { stdin?: string; allowFail?: boolean }): Promise<string> {
  const proc = spawn(cmd, {
    stdin: opts?.stdin != null ? Buffer.from(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0 && !opts?.allowFail) {
    const detail = (stderr || stdout).trim();
    throw new Error(`${cmd.join(" ")} failed (${exit})${detail ? `\n${detail}` : ""}`);
  }
  return stdout;
}

export class TartGuest {
  ip: string | null = null;

  constructor(readonly config: TartConfig) {}

  sshTarget(): string {
    if (!this.ip) throw new Error("guest has no IP; call connect() first");
    return `${this.config.user}@${this.ip}`;
  }

  async tartIp(): Promise<string | null> {
    const out = await run(["tart", "ip", this.config.vm], { allowFail: true });
    const ip = out.trim();
    return ip || null;
  }

  async isRunning(): Promise<boolean> {
    const out = await run(["tart", "get", this.config.vm], { allowFail: true });
    return /\brunning\b/.test(out);
  }

  async connect(): Promise<void> {
    this.ip = await this.tartIp();
    if (!this.ip) throw new Error(`${this.config.vm} has no IP`);
  }

  async ssh(script: string): Promise<string> {
    return run(["ssh", ...SSH_OPTS, this.sshTarget(), "bash", "-s"], { stdin: script });
  }

  async sshInherit(script: string): Promise<number> {
    const proc = spawn(["ssh", ...SSH_OPTS, this.sshTarget(), "bash", "-s"], {
      stdin: Buffer.from(script),
      stdout: "inherit",
      stderr: "inherit",
    });
    return proc.exited;
  }

  async scp(files: string[], dest: string): Promise<void> {
    await run(["scp", ...SSH_OPTS, ...files, `${this.sshTarget()}:${dest}`]);
  }

  async tarTo(srcDir: string, paths: string[], destDir: string): Promise<void> {
    const tar = spawn(["tar", "-C", srcDir, "-cf", "-", ...paths], { stdout: "pipe", stderr: "pipe" });
    const ssh = spawn(["ssh", ...SSH_OPTS, this.sshTarget(), "tar", "-C", destDir, "-xf", "-"], {
      stdin: tar.stdout,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exit] = await Promise.all([new Response(ssh.stderr).text(), ssh.exited]);
    if (exit !== 0) throw new Error(`stage tar failed (${exit})${stderr ? `\n${stderr}` : ""}`);
  }

  async sshOk(command: string[]): Promise<boolean> {
    const proc = spawn(["ssh", ...SSH_OPTS, this.sshTarget(), ...command], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  }

  async waitSsh(tries = 40): Promise<void> {
    for (let i = 0; i < tries; i++) {
      this.ip = await this.tartIp();
      if (this.ip && (await this.sshOk(["true"]))) return;
      await Bun.sleep(2000);
    }
    throw new Error(`could not SSH to ${this.config.user}@${this.config.vm}. Run: bun run tart setup`);
  }

  async ensureRunning(): Promise<void> {
    if (await this.isRunning()) {
      await this.connect();
      return;
    }

    console.log(`starting ${this.config.vm} with ${this.config.repoDir} mounted as ${this.config.shareName}`);
    spawn(
      [
        "tart",
        "run",
        "--no-graphics",
        "--no-clipboard",
        "--no-audio",
        "--dir",
        `${this.config.shareName}:${this.config.repoDir}`,
        this.config.vm,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    for (let i = 0; i < 60; i++) {
      this.ip = await this.tartIp();
      if (this.ip) return;
      await Bun.sleep(2000);
    }
    throw new Error("tart VM never got an IP");
  }
}

function publicKey(): string {
  for (const name of ["id_ed25519.pub", "id_rsa.pub"]) {
    const path = `${homedir()}/.ssh/${name}`;
    if (existsSync(path)) return readFileSync(path, "utf-8").trim();
  }
  throw new Error("no ~/.ssh/id_ed25519.pub or id_rsa.pub");
}

export async function setupGuest(guest: TartGuest): Promise<void> {
  const { vm, user } = guest.config;
  const pub = publicKey();
  if (!(await guest.isRunning())) {
    throw new Error("start the VM first (bun run tart up)");
  }
  await guest.connect();

  // Creating the non-console user is the one place `tart exec` as admin is OK.
  // Tests SSH as this user so Aqua/pbpaste match EAS.
  await run([
    "tart",
    "exec",
    vm,
    "/bin/bash",
    "-lc",
    `
set -euo pipefail
if ! id ${user} >/dev/null 2>&1; then
  sudo sysadminctl -addUser ${user} -password ${user} -fullName ${user}
fi
sudo systemsetup -setremotelogin on >/dev/null || true
sudo dseditgroup -o edit -a ${user} -t user com.apple.access_ssh || true
hom=$(dscl . -read /Users/${user} NFSHomeDirectory | awk '{print $2}')
sudo mkdir -p "$hom/.ssh"
sudo touch "$hom/.ssh/authorized_keys"
if ! sudo grep -qxF ${JSON.stringify(pub)} "$hom/.ssh/authorized_keys"; then
  printf '%s\\n' ${JSON.stringify(pub)} | sudo tee -a "$hom/.ssh/authorized_keys" >/dev/null
fi
sudo chmod 700 "$hom/.ssh"
sudo chmod 600 "$hom/.ssh/authorized_keys"
sudo chown -R ${user}:staff "$hom/.ssh"
`,
  ]);

  const bunPresent = (await guest.ssh('if test -x "$HOME/.bun/bin/bun"; then echo ok; fi')).trim() === "ok";
  if (!bunPresent) {
    const bunBin = Bun.which("bun");
    if (!bunBin) throw new Error("bun is not on the host PATH");
    await guest.scp([bunBin], "/tmp/bun");
    await guest.ssh('mkdir -p "$HOME/.bun/bin" && mv /tmp/bun "$HOME/.bun/bin/bun" && chmod +x "$HOME/.bun/bin/bun"');
  }
  await guest.waitSsh();
  console.log(`setup ok (${guest.config.user}@${guest.ip})`);
}
