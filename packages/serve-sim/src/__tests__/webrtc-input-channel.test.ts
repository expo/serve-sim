import { describe, expect, test } from "bun:test";
import {
  dataChannelSendTarget,
  GestureStamper,
  HidTransportRouter,
  type InputChannelLike,
} from "../client/webrtc-input-channel";

const TAG_TOUCH = 0x03;
const TAG_MULTI_TOUCH = 0x05;
const TAG_BUTTON = 0x04;
const TAG_KEY = 0x06;
const TAG_DIGITAL_CROWN = 0x0a;
const TAG_SCROLL = 0x0b;

const SOCKET = { via: "socket" } as const;
const INPUT = { via: "channel", lanes: ["input"] } as const;
const MOVES = { via: "channel", lanes: ["moves"] } as const;
const BOTH = { via: "channel", lanes: ["input", "moves"] } as const;

describe("HidTransportRouter", () => {
  test("routes to the socket while no channel is open", () => {
    const router = new HidTransportRouter();
    expect(router.route(TAG_BUTTON, { button: "home" }, false)).toEqual(SOCKET);
    expect(router.route(TAG_TOUCH, { type: "begin" }, false)).toEqual(SOCKET);
  });

  test("prefers the reliable channel for idle events once it is open", () => {
    const router = new HidTransportRouter();
    expect(router.route(TAG_BUTTON, { button: "home" }, true)).toEqual(INPUT);
    expect(router.route(TAG_KEY, { type: "down", usage: 4 }, true)).toEqual(INPUT);
    // Without the lossy lane, deltas ride the reliable channel too.
    expect(router.route(TAG_SCROLL, { dx: 0, dy: 1 }, true)).toEqual(INPUT);
  });

  test("puts gesture boundaries on both lanes and moves on the lossy one", () => {
    const router = new HidTransportRouter();
    expect(router.route(TAG_TOUCH, { type: "begin" }, true, true)).toEqual(BOTH);
    expect(router.route(TAG_TOUCH, { type: "move" }, true, true)).toEqual(MOVES);
    expect(router.route(TAG_TOUCH, { type: "move" }, true, true)).toEqual(MOVES);
    expect(router.route(TAG_TOUCH, { type: "end" }, true, true)).toEqual(BOTH);
    expect(router.route(TAG_MULTI_TOUCH, { type: "begin" }, true, true)).toEqual(BOTH);
    expect(router.route(TAG_MULTI_TOUCH, { type: "move" }, true, true)).toEqual(MOVES);
    expect(router.route(TAG_MULTI_TOUCH, { type: "end" }, true, true)).toEqual(BOTH);
  });

  test("puts scroll and crown deltas on the lossy lane, everything else on the reliable one", () => {
    const router = new HidTransportRouter();
    expect(router.route(TAG_SCROLL, { dx: 0, dy: 1 }, true, true)).toEqual(MOVES);
    expect(router.route(TAG_DIGITAL_CROWN, { delta: 1 }, true, true)).toEqual(MOVES);
    expect(router.route(TAG_BUTTON, { button: "home" }, true, true)).toEqual(INPUT);
    expect(router.route(TAG_KEY, { type: "down", usage: 4 }, true, true)).toEqual(INPUT);
  });

  test("a gesture stays on the transport it began on", () => {
    const router = new HidTransportRouter();
    // Begin while the channel is still closed: the whole gesture rides the socket.
    expect(router.route(TAG_TOUCH, { type: "begin" }, false)).toEqual(SOCKET);
    expect(router.route(TAG_TOUCH, { type: "move" }, true, true)).toEqual(SOCKET);
    expect(router.route(TAG_TOUCH, { type: "end" }, true, true)).toEqual(SOCKET);
    // The next gesture starts at a boundary and may switch.
    expect(router.route(TAG_TOUCH, { type: "begin" }, true, true)).toEqual(BOTH);
    expect(router.route(TAG_TOUCH, { type: "move" }, true, true)).toEqual(MOVES);
    expect(router.route(TAG_TOUCH, { type: "end" }, true, true)).toEqual(BOTH);
  });

  test("falls back to the socket when the input channel dies mid-gesture", () => {
    const router = new HidTransportRouter();
    expect(router.route(TAG_TOUCH, { type: "begin" }, true, true)).toEqual(BOTH);
    // A closed channel cannot deliver anything late, so an immediate switch is safe.
    expect(router.route(TAG_TOUCH, { type: "move" }, false, false)).toEqual(SOCKET);
    expect(router.route(TAG_TOUCH, { type: "end" }, false, false)).toEqual(SOCKET);
  });

  test("keeps a gesture on the reliable lane when only the lossy channel dies", () => {
    const router = new HidTransportRouter();
    expect(router.route(TAG_TOUCH, { type: "begin" }, true, true)).toEqual(BOTH);
    expect(router.route(TAG_TOUCH, { type: "move" }, true, false)).toEqual(INPUT);
    expect(router.route(TAG_TOUCH, { type: "end" }, true, false)).toEqual(INPUT);
  });

  test("non-gesture events follow an in-flight gesture's transport", () => {
    const router = new HidTransportRouter();
    expect(router.route(TAG_TOUCH, { type: "begin" }, false)).toEqual(SOCKET);
    // The channel opened mid-drag; a key press keeps ordering with the drag.
    expect(router.route(TAG_BUTTON, { button: "home" }, true)).toEqual(SOCKET);
    expect(router.route(TAG_TOUCH, { type: "end" }, true)).toEqual(SOCKET);
    expect(router.route(TAG_BUTTON, { button: "home" }, true)).toEqual(INPUT);
  });

  test("touch and multi-touch gestures are tracked independently", () => {
    const router = new HidTransportRouter();
    expect(router.route(TAG_TOUCH, { type: "begin" }, true)).toEqual(INPUT);
    expect(router.route(TAG_MULTI_TOUCH, { type: "begin" }, true)).toEqual(INPUT);
    expect(router.route(TAG_TOUCH, { type: "end" }, true)).toEqual(INPUT);
    // The multi-touch gesture is still active: no re-evaluation happens yet.
    expect(router.route(TAG_MULTI_TOUCH, { type: "move" }, false)).toEqual(SOCKET);
    expect(router.route(TAG_MULTI_TOUCH, { type: "end" }, false)).toEqual(SOCKET);
  });

  test("an end without a begin routes like an idle event", () => {
    const router = new HidTransportRouter();
    expect(router.route(TAG_TOUCH, { type: "end" }, true, true)).toEqual(BOTH);
    expect(router.route(TAG_TOUCH, { type: "begin" }, true, true)).toEqual(BOTH);
  });
});

describe("GestureStamper", () => {
  test("numbers each gesture and sequences its events from the begin", () => {
    const stamper = new GestureStamper();
    expect(stamper.stamp(TAG_TOUCH, { type: "begin", x: 0.1, y: 0.2 })).toEqual({ type: "begin", x: 0.1, y: 0.2, g: 1, s: 0 });
    expect(stamper.stamp(TAG_TOUCH, { type: "move", x: 0.2, y: 0.2 })).toEqual({ type: "move", x: 0.2, y: 0.2, g: 1, s: 1 });
    expect(stamper.stamp(TAG_TOUCH, { type: "move", x: 0.3, y: 0.2 })).toEqual({ type: "move", x: 0.3, y: 0.2, g: 1, s: 2 });
    expect(stamper.stamp(TAG_TOUCH, { type: "end", x: 0.3, y: 0.2 })).toEqual({ type: "end", x: 0.3, y: 0.2, g: 1, s: 3 });
    // The next gesture gets a fresh id and restarts the sequence.
    expect(stamper.stamp(TAG_TOUCH, { type: "begin", x: 0.5, y: 0.5 })).toEqual({ type: "begin", x: 0.5, y: 0.5, g: 2, s: 0 });
  });

  test("shares the gesture counter across touch and multi-touch but tracks their sequences apart", () => {
    const stamper = new GestureStamper();
    expect(stamper.stamp(TAG_TOUCH, { type: "begin" })).toEqual({ type: "begin", g: 1, s: 0 });
    expect(stamper.stamp(TAG_MULTI_TOUCH, { type: "begin" })).toEqual({ type: "begin", g: 2, s: 0 });
    expect(stamper.stamp(TAG_TOUCH, { type: "move" })).toEqual({ type: "move", g: 1, s: 1 });
    expect(stamper.stamp(TAG_MULTI_TOUCH, { type: "move" })).toEqual({ type: "move", g: 2, s: 1 });
    expect(stamper.stamp(TAG_TOUCH, { type: "end" })).toEqual({ type: "end", g: 1, s: 2 });
    expect(stamper.stamp(TAG_MULTI_TOUCH, { type: "end" })).toEqual({ type: "end", g: 2, s: 2 });
  });

  test("leaves non-touch messages and orphan moves unstamped", () => {
    const stamper = new GestureStamper();
    const button = { button: "home" };
    expect(stamper.stamp(TAG_BUTTON, button)).toBe(button);
    const scroll = { dx: 0, dy: 1, x: 0.5, y: 0.5 };
    expect(stamper.stamp(TAG_SCROLL, scroll)).toBe(scroll);
    // A move with no begin in flight is legacy input to the server.
    const orphan = { type: "move", x: 0.5, y: 0.5 };
    expect(stamper.stamp(TAG_TOUCH, orphan)).toBe(orphan);
    const orphanEnd = { type: "end", x: 0.5, y: 0.5 };
    expect(stamper.stamp(TAG_TOUCH, orphanEnd)).toBe(orphanEnd);
  });

  test("does not mutate the caller's payload", () => {
    const stamper = new GestureStamper();
    const payload = { type: "begin", x: 0.1, y: 0.2 };
    stamper.stamp(TAG_TOUCH, payload);
    expect(payload).toEqual({ type: "begin", x: 0.1, y: 0.2 });
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
