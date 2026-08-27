import { describe, expect, test } from "bun:test";
import {
  dataChannelSendTarget,
  HidTransportRouter,
  type InputChannelLike,
} from "../client/webrtc-input-channel";

const TAG_TOUCH = 0x03;
const TAG_MULTI_TOUCH = 0x05;
const TAG_BUTTON = 0x04;
const TAG_SCROLL = 0x0b;

describe("HidTransportRouter", () => {
  test("routes to the socket while no channel is open", () => {
    const router = new HidTransportRouter();
    expect(router.route(TAG_BUTTON, { button: "home" }, false)).toBe("socket");
    expect(router.route(TAG_TOUCH, { type: "begin" }, false)).toBe("socket");
  });

  test("prefers the channel for idle events once it is open", () => {
    const router = new HidTransportRouter();
    expect(router.route(TAG_BUTTON, { button: "home" }, true)).toBe("channel");
    expect(router.route(TAG_SCROLL, { dx: 0, dy: 1 }, true)).toBe("channel");
  });

  test("a gesture stays on the transport it began on", () => {
    const router = new HidTransportRouter();
    // Begin while the channel is still closed: the whole gesture rides the socket.
    expect(router.route(TAG_TOUCH, { type: "begin" }, false)).toBe("socket");
    expect(router.route(TAG_TOUCH, { type: "move" }, true)).toBe("socket");
    expect(router.route(TAG_TOUCH, { type: "end" }, true)).toBe("socket");
    // The next gesture starts at a boundary and may switch.
    expect(router.route(TAG_TOUCH, { type: "begin" }, true)).toBe("channel");
    expect(router.route(TAG_TOUCH, { type: "move" }, true)).toBe("channel");
    expect(router.route(TAG_TOUCH, { type: "end" }, true)).toBe("channel");
  });

  test("falls back to the socket when the channel dies mid-gesture", () => {
    const router = new HidTransportRouter();
    expect(router.route(TAG_TOUCH, { type: "begin" }, true)).toBe("channel");
    // A closed channel cannot deliver anything late, so an immediate switch is safe.
    expect(router.route(TAG_TOUCH, { type: "move" }, false)).toBe("socket");
    expect(router.route(TAG_TOUCH, { type: "end" }, false)).toBe("socket");
  });

  test("non-gesture events follow an in-flight gesture's transport", () => {
    const router = new HidTransportRouter();
    expect(router.route(TAG_TOUCH, { type: "begin" }, false)).toBe("socket");
    // The channel opened mid-drag; a key press keeps ordering with the drag.
    expect(router.route(TAG_BUTTON, { button: "home" }, true)).toBe("socket");
    expect(router.route(TAG_TOUCH, { type: "end" }, true)).toBe("socket");
    expect(router.route(TAG_BUTTON, { button: "home" }, true)).toBe("channel");
  });

  test("touch and multi-touch gestures are tracked independently", () => {
    const router = new HidTransportRouter();
    expect(router.route(TAG_TOUCH, { type: "begin" }, true)).toBe("channel");
    expect(router.route(TAG_MULTI_TOUCH, { type: "begin" }, true)).toBe("channel");
    expect(router.route(TAG_TOUCH, { type: "end" }, true)).toBe("channel");
    // The multi-touch gesture is still active: no re-evaluation happens yet.
    expect(router.route(TAG_MULTI_TOUCH, { type: "move" }, false)).toBe("socket");
    expect(router.route(TAG_MULTI_TOUCH, { type: "end" }, false)).toBe("socket");
  });

  test("an end without a begin routes like an idle event", () => {
    const router = new HidTransportRouter();
    expect(router.route(TAG_TOUCH, { type: "end" }, true)).toBe("channel");
    expect(router.route(TAG_TOUCH, { type: "begin" }, true)).toBe("channel");
  });
});

describe("dataChannelSendTarget", () => {
  function channel(readyState: string): InputChannelLike & { sent: ArrayBuffer[] } {
    const sent: ArrayBuffer[] = [];
    return {
      readyState,
      sent,
      send(data: ArrayBuffer) {
        sent.push(data);
      },
    };
  }

  test("returns null unless the channel is open", () => {
    expect(dataChannelSendTarget(null)).toBeNull();
    expect(dataChannelSendTarget(undefined)).toBeNull();
    expect(dataChannelSendTarget(channel("connecting"))).toBeNull();
    expect(dataChannelSendTarget(channel("closing"))).toBeNull();
    expect(dataChannelSendTarget(channel("closed"))).toBeNull();
  });

  test("adapts an open channel to the WebSocket send-target shape", () => {
    const dc = channel("open");
    const target = dataChannelSendTarget(dc);
    expect(target).not.toBeNull();
    expect(target!.readyState).toBe(1);
    const payload = new ArrayBuffer(3);
    target!.send(payload);
    expect(dc.sent).toEqual([payload]);
  });

  test("drops the message when the channel closed after the target was made", () => {
    const dc = channel("open");
    const target = dataChannelSendTarget(dc)!;
    dc.readyState = "closing";
    target.send(new ArrayBuffer(1));
    expect(dc.sent).toEqual([]);
  });

  test("swallows a send that throws while the channel tears down", () => {
    const dc = channel("open");
    dc.send = () => {
      throw new Error("InvalidStateError");
    };
    const target = dataChannelSendTarget(dc)!;
    expect(() => target.send(new ArrayBuffer(1))).not.toThrow();
  });
});
