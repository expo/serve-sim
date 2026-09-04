import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";

// Compiles the trampoline's C for the host and runs its assertions under
// AddressSanitizer and UndefinedBehaviorSanitizer, then runs clang's static
// analyzer over the shipped source. Needs no simulator: the dylib ships for
// iOS, but the parsing it does is the same code built for the host.
const RUNNER = join(import.meta.dir, "../../Sources/ServeSimTrampoline/tests/run.sh");

describe.skipIf(!existsSync(RUNNER))("trampoline C", () => {
  test("parses its config safely and analyzes clean", async () => {
    const proc = Bun.spawn(["bash", RUNNER], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(`${stdout}${stderr}`).not.toContain("FAIL ");
    expect(code).toBe(0);
    expect(stdout).toContain("analyzer clean");
  }, 120_000);
});
