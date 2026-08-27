import { existsSync } from "fs";
import { join, resolve } from "path";
import { dirnameOf } from "./runtime";

// Bun's bundler inlines a bare `__dirname` as the build machine's source
// directory; shadow it with the runtime location so the published bundle finds
// dist/simpb next to itself (same pattern as ui-settings.ts).
const __dirname = dirnameOf(import.meta.url);

export function locatePasteboardTool(): string | null {
  const candidates = [
    join(__dirname, "..", "dist", "simpb", "serve-sim-pasteboard"),
    join(__dirname, "simpb", "serve-sim-pasteboard"),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return resolve(candidate);
  return null;
}
