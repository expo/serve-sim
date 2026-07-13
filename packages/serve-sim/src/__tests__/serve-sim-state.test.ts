import { describe, expect, test } from "bun:test";
import { inProcessServeSimState } from "../state";

describe("inProcessServeSimState", () => {
  test("scopes the stream by path and the control WebSocket by query param", () => {
    const state = inProcessServeSimState("DEVICE-A", 3100);
    expect(state.url).toBe("http://127.0.0.1:3100");
    expect(state.streamUrl).toBe("http://127.0.0.1:3100/helper/DEVICE-A/stream.mjpeg");
    expect(state.wsUrl).toBe("ws://127.0.0.1:3100/helper/ws?device=DEVICE-A");
  });

  test("keeps the mount prefix ahead of the helper routes", () => {
    const state = inProcessServeSimState("DEVICE-A", 3100, "/preview");
    expect(state.streamUrl).toBe("http://127.0.0.1:3100/preview/helper/DEVICE-A/stream.mjpeg");
    expect(state.wsUrl).toBe("ws://127.0.0.1:3100/preview/helper/ws?device=DEVICE-A");
  });

  test("swaps wildcard bind addresses for loopback", () => {
    const state = inProcessServeSimState("DEVICE-A", 3100, "/", "0.0.0.0");
    expect(state.wsUrl).toBe("ws://127.0.0.1:3100/helper/ws?device=DEVICE-A");
  });
});
