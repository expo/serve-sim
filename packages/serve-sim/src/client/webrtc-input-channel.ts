import { WS_OPEN_READY_STATE, type WsSendTarget } from "./utils/ws-send-queue";

/**
 * Routing for HID input when WebRTC carries the video: latency-critical input
 * rides an "input" data channel on the media path (UDP, no tunnel hops), while
 * the `/ws` control socket stays open for screen config and as the fallback.
 *
 * The two transports are each ordered, but their combined delivery order is
 * undefined — the exact hazard docs/webrtc-architecture.md called out when
 * data-channel input was first removed. `HidTransportRouter` closes it by only
 * switching transports at gesture boundaries: every begin/move/end of one
 * gesture travels on the transport the gesture began on.
 */

const TAG_TOUCH = 0x03;
const TAG_MULTI_TOUCH = 0x05;

export type InputRoute = "channel" | "socket";

export class HidTransportRouter {
  private current: InputRoute = "socket";
  private readonly activeGestureTags = new Set<number>();

  /**
   * Pick the transport for one `[tag][JSON]` frame. `channelOpen` is whether
   * the input data channel can send right now.
   *
   * - At a gesture boundary (no touch or multi-touch in flight) the router
   *   re-evaluates and prefers the channel when it is open.
   * - While a gesture is in flight, every event — including non-gesture tags
   *   like keys, whose order relative to the gesture matters — follows the
   *   gesture's transport.
   * - If the gesture's channel closed under it, the rest of the gesture falls
   *   back to the socket immediately. A closed channel delivers nothing late,
   *   so the switch cannot reorder events.
   */
  route(tag: number, payload: object, channelOpen: boolean): InputRoute {
    if (this.activeGestureTags.size === 0) {
      this.current = channelOpen ? "channel" : "socket";
    } else if (this.current === "channel" && !channelOpen) {
      this.current = "socket";
    }

    if (tag === TAG_TOUCH || tag === TAG_MULTI_TOUCH) {
      const type = (payload as { type?: unknown }).type;
      if (type === "begin") this.activeGestureTags.add(tag);
      else if (type === "end") this.activeGestureTags.delete(tag);
    }

    return this.current;
  }
}

/** The subset of RTCDataChannel the adapter needs; structural so tests need no DOM. */
export type InputChannelLike = {
  readyState: string;
  send(data: ArrayBuffer): void;
};

/**
 * Adapt an open input data channel to the `WsSendTarget` shape the shared
 * send queue understands. Returns null unless the channel is open, so callers
 * can treat "no target" and "not open yet" the same way.
 *
 * A message that races the channel's teardown is dropped silently: the router
 * re-routes the very next event to the socket, and a lost move (or an end the
 * next begin supersedes) is cheaper than a crash in a pointer event handler.
 */
export function dataChannelSendTarget(
  channel: InputChannelLike | null | undefined,
): WsSendTarget | null {
  if (!channel || channel.readyState !== "open") return null;
  return {
    readyState: WS_OPEN_READY_STATE,
    send(data: ArrayBuffer) {
      if (channel.readyState !== "open") return;
      try {
        channel.send(data);
      } catch {
        // Closing race; the next event re-routes to the socket.
      }
    },
  };
}
