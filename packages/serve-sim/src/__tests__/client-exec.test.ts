import { describe, expect, it } from "bun:test";

import { join } from "path";

// exec.ts caches its socket at module scope and this fixture replaces global WebSocket, so it runs
// in its own process rather than depending on being the first file to touch either.
describe("client runHostAction", () => {
  it("handshakes, pairs replies, and maps refusals to failed results", async () => {
    const child = Bun.spawn(["bun", "test", "./src/__tests__/fixtures/client-exec.child.ts"], {
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toContain("6 pass");
    expect(exitCode).toBe(0);
  }, 30_000);
});
