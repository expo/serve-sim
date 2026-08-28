import { existsSync, watch } from "fs";
import { join } from "path";
import type { TartGuest } from "./guest";
import { testOnce } from "./stage";

async function buildNative(pkgDir: string): Promise<void> {
  const proc = Bun.spawn(["bun", "run", "build"], {
    cwd: pkgDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error("host build failed");
}

function shouldRebuild(path: string): boolean {
  return path.includes("/Sources/") || path.endsWith("build.ts");
}

export async function watchDev(guest: TartGuest, files: string[]): Promise<void> {
  const { pkgDir } = guest.config;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rebuild = false;
  let running = false;
  let queued = false;

  const run = async () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      if (rebuild) {
        rebuild = false;
        console.log("building on host");
        await buildNative(pkgDir);
      }
      const code = await testOnce(guest, files);
      if (code !== 0) console.error(`guest tests exited ${code}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        void run();
      }
    }
  };

  const kick = (path?: string) => {
    if (path && shouldRebuild(path)) rebuild = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void run();
    }, 400);
  };

  for (const dir of ["src", "Sources", "dist/simpb"].map((rel) => join(pkgDir, rel))) {
    if (!existsSync(dir)) continue;
    watch(dir, { recursive: true }, (_event, filename) => {
      if (filename) kick(join(dir, String(filename)));
    });
  }

  console.log("tart dev: watching src, Sources, dist/simpb (Ctrl-C to stop)");
  await run();
  await new Promise(() => {});
}
