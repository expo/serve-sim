import { describe, expect, it } from "bun:test";

import { inProcessServeSimState, serverBaseUrl } from "../state";

describe("serverBaseUrl", () => {
  const UDID = "ABCD1234-0000-0000-0000-0000000000EF";

  it("is the origin for a standalone server", () => {
    expect(serverBaseUrl(inProcessServeSimState(UDID, 3100))).toBe("http://127.0.0.1:3100");
  });

  it("keeps the mount prefix of an embedded server", () => {
    expect(serverBaseUrl(inProcessServeSimState(UDID, 3200, "/.sim"))).toBe("http://127.0.0.1:3200/.sim");
    expect(serverBaseUrl(inProcessServeSimState(UDID, 3200, "tools/sim/"))).toBe("http://127.0.0.1:3200/tools/sim");
  });
});

