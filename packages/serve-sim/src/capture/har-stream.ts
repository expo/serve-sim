import { createReadStream, createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { finished } from "node:stream/promises";

import { emptyHar, type HarEntry } from "./har";

export function emptyHarText(creatorVersion: string): string {
  return `${JSON.stringify(emptyHar(creatorVersion))}\n`;
}

function harEnvelope(creatorVersion: string): { open: Buffer; close: Buffer } {
  const json = JSON.stringify(emptyHar(creatorVersion));
  const marker = '"entries":[]';
  const at = json.indexOf(marker);
  if (at < 0) {
    throw new Error("emptyHar() shape changed; cannot build streaming HAR envelope");
  }
  // `"entries":[]` → open through `[`, close from the array's `]` through the root `}`.
  return {
    open: Buffer.from(`${json.slice(0, at)}"entries":[`),
    close: Buffer.from(`${json.slice(at + marker.length - 1)}\n`),
  };
}

export async function writeChunk(stream: WriteStream, chunk: string | Buffer): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, "drain");
  }
}

async function streamHarBody(
  outPath: string,
  creatorVersion: string,
  writeEntries: (out: WriteStream) => Promise<void>,
): Promise<void> {
  const { open, close } = harEnvelope(creatorVersion);
  const tmp = `${outPath}.${process.pid}.tmp`;
  const out = createWriteStream(tmp);
  const done = finished(out);
  try {
    await writeChunk(out, open);
    await writeEntries(out);
    await writeChunk(out, close);
    out.end();
    await done;
    await rename(tmp, outPath);
  } catch (err) {
    out.destroy();
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Stream-rebuild a HAR from an NDJSON file of HarEntry lines. */
export async function streamHarFromNdjsonFile(
  entriesPath: string,
  outPath: string,
  creatorVersion: string,
): Promise<void> {
  await streamHarBody(outPath, creatorVersion, async (out) => {
    let first = true;
    const input = createReadStream(entriesPath, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line) continue;
        if (!first) await writeChunk(out, ",");
        first = false;
        await writeChunk(out, Buffer.from(line));
      }
    } finally {
      lines.close();
      input.destroy();
    }
  });
}

/** Stream-write a HAR from in-memory entries (one JSON.stringify per entry). */
export async function streamHarFromEntries(
  entries: HarEntry[],
  outPath: string,
  creatorVersion: string,
): Promise<void> {
  await streamHarBody(outPath, creatorVersion, async (out) => {
    for (let i = 0; i < entries.length; i++) {
      if (i > 0) await writeChunk(out, ",");
      await writeChunk(out, Buffer.from(JSON.stringify(entries[i])));
    }
  });
}

/**
 * One pass count + optional compact: drop oldest NDJSON lines past `maxEntries`
 * and stream-rebuild the HAR. Line count comes from the file, not a caller counter.
 * Returns the kept line count.
 */
export async function compactNdjsonAndStreamHar(
  entriesPath: string,
  harPath: string,
  creatorVersion: string,
  maxEntries: number,
): Promise<number> {
  let currentCount = 0;
  {
    const input = createReadStream(entriesPath, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line) currentCount += 1;
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }

  if (currentCount <= maxEntries) {
    await streamHarFromNdjsonFile(entriesPath, harPath, creatorVersion);
    return currentCount;
  }

  const skip = currentCount - maxEntries;
  const { open, close } = harEnvelope(creatorVersion);
  const entriesTmp = `${entriesPath}.${process.pid}.compact.tmp`;
  const harTmp = `${harPath}.${process.pid}.tmp`;
  const entriesOut = createWriteStream(entriesTmp);
  const harOut = createWriteStream(harTmp);
  const entriesDone = finished(entriesOut);
  const harDone = finished(harOut);
  let skipped = 0;
  let kept = 0;
  const input = createReadStream(entriesPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    await writeChunk(harOut, open);
    for await (const line of lines) {
      if (!line) continue;
      if (skipped < skip) {
        skipped += 1;
        continue;
      }
      await writeChunk(entriesOut, `${line}\n`);
      if (kept > 0) await writeChunk(harOut, ",");
      await writeChunk(harOut, Buffer.from(line));
      kept += 1;
    }
    await writeChunk(harOut, close);
    entriesOut.end();
    harOut.end();
    await Promise.all([entriesDone, harDone]);
    await rename(entriesTmp, entriesPath);
    await rename(harTmp, harPath);
    return kept;
  } catch (err) {
    entriesOut.destroy();
    harOut.destroy();
    await unlink(entriesTmp).catch(() => {});
    await unlink(harTmp).catch(() => {});
    throw err;
  } finally {
    lines.close();
    input.destroy();
  }
}
