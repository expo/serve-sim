import { chromium, devices } from "playwright";
import { mkdir, rename, readdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BASE = process.env.SERVE_SIM_URL ?? "http://localhost:3200";
const OUT = path.resolve(import.meta.dirname, "videos");

async function maybeVisible(locator, timeout = 8_000) {
  try {
    await locator.waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

async function toMp4(webmPath) {
  const mp4Path = webmPath.replace(/\.webm$/, ".mp4");
  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    webmPath,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    mp4Path,
  ]);
  console.log(`wrote ${mp4Path}`);
}

async function record(name, options, run) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...options,
    recordVideo: { dir: OUT, size: options.viewport },
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector("canvas, video", { timeout: 30_000 });
  await page.waitForTimeout(2500);
  await run(page);
  await page.waitForTimeout(800);
  const video = page.video();
  await context.close();
  await browser.close();
  if (!video) return;
  const src = await video.path();
  const dest = path.join(OUT, `${name}.webm`);
  await rename(src, dest);
  console.log(`wrote ${dest}`);
  await toMp4(dest);
}

await mkdir(OUT, { recursive: true });
for (const file of await readdir(OUT)) {
  if (/^[a-f0-9]{32}\.webm$/.test(file)) {
    await rename(path.join(OUT, file), path.join(OUT, file)).catch(() => {});
  }
}

await record(
  "desktop-preview",
  { viewport: { width: 1280, height: 800 } },
  async (page) => {
    const tools = page.getByRole("button", { name: "Open tools panel" });
    if (await maybeVisible(tools)) {
      await tools.click();
      await page.waitForTimeout(700);
      await tools.click();
    }
    const fullscreen = page.getByRole("button", { name: "Full screen" });
    if (await maybeVisible(fullscreen)) {
      await fullscreen.click();
      await page.waitForTimeout(900);
      const exit = page.getByRole("button", { name: "Exit full screen" });
      if (await maybeVisible(exit, 5_000)) await exit.click();
    }
  },
);

await record(
  "mobile-preview",
  {
    ...devices["iPhone 13"],
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  },
  async (page) => {
    await page.emulateMedia({ pointer: "coarse" });

    const tools = page.getByRole("button", { name: "Open tools panel" });
    if (await maybeVisible(tools)) {
      await tools.click();
      await page.waitForTimeout(600);
      await tools.click();
    }

    const keyboard = page.getByRole("button", { name: "Keyboard" });
    if (await maybeVisible(keyboard)) {
      await keyboard.click();
      await page.waitForTimeout(400);
      await page.keyboard.type("hello");
      await page.waitForTimeout(700);
      await keyboard.click();
    }

    const fullscreen = page.getByRole("button", { name: "Full screen" });
    if (await maybeVisible(fullscreen)) {
      await fullscreen.click();
      await page.waitForTimeout(900);
      const exit = page.getByRole("button", { name: "Exit full screen" });
      if (await maybeVisible(exit, 5_000)) await exit.click();
    }
  },
);
