import { describe, expect, it } from "bun:test";

import { runChildSuite } from "./fixtures/run-child-suite";

// The ceiling assertions need os.homedir() redirected, and that binding survives mock.restore, so
// they run in their own process rather than poisoning every later file in the suite.
describe("screenshot ceiling", () => {
  it("holds the Desktop ceiling and ignores unrelated files", async () => {
    const { exitCode, output } = await runChildSuite("screenshot-ceiling.child.ts", {
      timeoutMs: 45_000,
    });
    expect(output).toContain("3 pass");
    expect(exitCode).toBe(0);
  }, 60_000);
});
