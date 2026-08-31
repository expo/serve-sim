import { describe, expect, test } from "bun:test";
import { guestPreviewScript } from "../dev";
import { SSH_OPTS, sshTunnelArgs } from "../guest";

describe("tart-dev", () => {
  test("guest preview cds to the share and runs bun dev.ts", () => {
    const share = "/Volumes/My Shared Files/serve-sim/packages/serve-sim";
    const script = guestPreviewScript(share, 3200);
    expect(script).toContain(`cd ${JSON.stringify(share)}`);
    expect(script).toContain("exec bun run dev.ts");
    expect(script).toContain("export PORT=3200");
    expect(script).not.toContain("simpb");
    expect(script).not.toContain("ln -sfn");
    expect(script).not.toContain("bun install");
  });

  test("tunnels guest loopback onto the host port", () => {
    expect(sshTunnelArgs("expo@192.168.64.4", 3200, 3200)).toEqual([
      "ssh",
      ...SSH_OPTS,
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      "3200:127.0.0.1:3200",
      "expo@192.168.64.4",
    ]);
  });
});
