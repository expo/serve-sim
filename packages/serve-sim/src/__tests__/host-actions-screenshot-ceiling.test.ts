import { describe, expect, it } from "bun:test";

import { join } from "path";

// The ceiling assertions need os.homedir() redirected, and that binding survives mock.restore, so
// they run in their own process rather than poisoning every later file in the suite.
describe("screenshot ceiling", () => {
  it("holds the Desktop ceiling and ignores unrelated files", async () => {
    // bun only auto-discovers files with ".test" in the name, so this fixture stays out of the
    // main run and is named here as an explicit relative path.
    const child = Bun.spawn(
      ["bun", "test", "./src/__tests__/fixtures/screenshot-ceiling.child.ts"],
      { cwd: join(import.meta.dir, "..", ".."), stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toContain("3 pass");
    expect(exitCode).toBe(0);
  }, 30_000);
});
