import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const ADDON = resolve(import.meta.dir, "../mitm-addon/servesim_capture.py");
const PROBE = resolve(import.meta.dir, "fixtures/servesim-capture-probe.py");

function python(): string | null {
  for (const candidate of ["python3", "/usr/bin/python3"]) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "pipe" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const PYTHON = python();
const describeOrSkip = PYTHON && existsSync(ADDON) ? describe : describe.skip;
if (!PYTHON) console.warn("[servesim_capture] skipping: no python3 on this host");

/** Every probe assertion comes from one addon instance, so the module state is shared as in production. */
function runProbe(): Record<string, unknown> {
  const result = spawnSync(PYTHON!, [PROBE, ADDON], { stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`probe failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}

describeOrSkip("servesim_capture addon", () => {
  const probe = PYTHON ? runProbe() : {};

  test("counts the bytes that crossed the wire, not the decompressed length", () => {
    // A gzipped body reported by its decoded size overstated throughput by several hundred times.
    expect(probe.compressedSize).toBe(90);
    expect(probe.compressedDecodedSize).toBe(10_000);
  });

  test("survives a body whose content-encoding does not match its bytes", () => {
    // Strict decoding raises, which kills the hook and leaves the row in flight forever.
    expect(probe.lyingBody).toBe("");
    expect(probe.lyingSize).toBe(14);
  });

  test("sends binary bodies as base64 rather than mojibake", () => {
    expect(probe.binaryBody).toBeNull();
    expect(probe.binaryBase64).toBe("//4AAQ==");
  });

  test("caps a body at the per-body limit and says it was cut", () => {
    expect(probe.oversizedTruncated).toBe(true);
    expect(probe.oversizedBodyLength).toBe(512 * 1024);
    // The full length is still reported, so a panel can say how much it is not showing.
    expect(probe.oversizedDecodedSize).toBe(512 * 1024 + 10);
  });

  test("reports an absent body as empty rather than as a cut one", () => {
    expect(probe.emptySize).toBe(0);
    expect(probe.emptyBody).toBe("");
    expect(probe.emptyTruncated).toBe(false);
  });

  test("lowercases header names, which the session looks up in lower case", () => {
    expect(probe.headerKeys).toEqual(["content-type"]);
  });

  test("announces itself so readiness proves the hooks are installed", () => {
    expect(probe.readyDelivered).toBe(true);
    expect(probe.readyPath).toBe("/ready?t=probe-token");
  });

  test("ignores a configured http_proxy when reporting", () => {
    // Records travelling through a developer's corporate proxy would be swallowed, and capture would
    // report itself healthy while recording nothing.
    expect(probe.proxyBypassed).toBe(true);
  });

  test("does not report a second row when a response arrived after an error", () => {
    expect(probe.errorSkippedWhenResponseExists).toBe(true);
  });

  test("opens and settles a row for a CONNECT that never established", () => {
    expect(probe.connectErrorFrames).toBe(2);
    expect(probe.connectErrorPaths).toEqual(["/request", "/response"]);
  });

  test("releases queued bytes as records drain", () => {
    expect(probe.queuedBytesAfterDrain).toBe(0);
  });

  test("drops a record rather than queueing past the byte limit", () => {
    expect(probe.oversizedRecordDropped).toBe(true);
    // A dropped record must not leave its size behind, or the limit creeps shut.
    expect(probe.queuedBytesAfterDrop).toBe(0);
  });

  test("shuts down cleanly when it was loaded without a control url", () => {
    // The reporter thread only starts when there is somewhere to report to, and joining a thread that
    // never started raises.
    const result = spawnSync(
      PYTHON!,
      [
        "-c",
        [
          "import importlib.util, os, sys",
          "os.environ.pop('SERVE_SIM_CAPTURE_CONTROL_URL', None)",
          `spec = importlib.util.spec_from_file_location('servesim_capture', ${JSON.stringify(ADDON)})`,
          "addon = importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(addon)",
          "addon.done()",
          "print('ok')",
        ].join("\n"),
      ],
      { stdio: "pipe", encoding: "utf8" },
    );
    expect(result.stderr).not.toContain("RuntimeError");
    expect(result.status).toBe(0);
  });

  test("redacts query values but keeps their names, so requests stay distinguishable", () => {
    // A URL alone carries OAuth codes, signed-URL keys and reset tokens; header redaction never saw them.
    expect(probe.urlQueryRedacted).toBe("https://a.test/cb?code=[REDACTED]&state=[REDACTED]");
  });

  test("leaves a URL without a query alone", () => {
    expect(probe.urlWithoutQueryUntouched).toBe("https://a.test/thing");
  });

  test("caps a URL whose redaction makes it longer, not just one long value", () => {
    // `a=1` becomes `a=[REDACTED]`, so a query of short pairs expands. Clipping before redacting looked
    // correct against a single long value and was 3x over the cap here.
    expect(probe.urlCappedExpanding).toBe(true);
    expect(probe.urlCapped).toBe(true);
  });

  test("redacts a bare query token, which is the whole credential", () => {
    expect(probe.urlBareTokenRedacted).toBe("https://a.test/cb?[REDACTED]");
  });

  test("counts a bodyless record against the queue limit", () => {
    // Body-only accounting sized this at zero, so a large URL or header set was unbounded.
    expect(probe.bodylessRecordCounted).toBe(true);
  });

  test("reports a request that failed before any response", () => {
    // This path builds the request part, so a signature change here used to raise inside the hook and the
    // row would never settle.
    expect(probe.errorWithoutResponseFrames).toBe(1);
    expect(probe.errorWithoutResponseMessage).toBe("connection reset");
  });
});
