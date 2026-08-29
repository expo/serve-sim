import { WS_OPEN_READY_STATE, type WsSendTarget } from "./utils/ws-send-queue";

/**
 * Routing for HID input when WebRTC carries the video.
 *
 * Latency-critical input rides the media path (UDP, direct or TURN, no tunnel
 * hops) on two data channels, while the `/ws` control socket stays open for
 * screen config and as the fallback:
 *
 * - `input` — ordered, reliable. Gesture boundaries (`begin`/`end`), buttons,
 *   keys, orientation: anything whose order or delivery must be exact.
 * - `moves` — unordered, lifetime-limited (dropped after ~100 ms instead of
 *   retransmitted). Touch `move`, scroll and crown deltas: a lost one is
 *   superseded by the next, and never stalls the events behind it the way a
 *   lost segment stalls an ordered stream for a retransmit round trip.
 *
 * `begin` and `end` are sent on *both* channels. The lossy copy usually lands
 * first; the reliable copy guarantees delivery. The server's sequencer applies
 * each once, using the gesture id `g` and sequence `s` that `GestureStamper`
 * puts on every touch message.
 *
 * The transports are each ordered (or deliberately not), but their combined
 * delivery order is undefined — the hazard docs/webrtc-architecture.md called
 * out when data-channel input was first removed. `HidTransportRouter` keeps
 * the WebSocket and the channels from interleaving one gesture by only
 * switching between them at gesture boundaries; the sequencer handles the
 * ordering between the two channels.
 */

const TAG_TOUCH = 0x03;
const TAG_MULTI_TOUCH = 0x05;
const TAG_DIGITAL_CROWN = 0x0a;
const TAG_SCROLL = 0x0b;

export type InputLane = "input" | "moves";

export type InputDispatch =
  | { via: "socket" }
  | { via: "channel"; lanes: readonly InputLane[] };

function touchPhase(tag: number, payload: object): "begin" | "move" | "end" | null {
  if (tag !== TAG_TOUCH && tag !== TAG_MULTI_TOUCH) return null;
  const type = (payload as { type?: unknown }).type;
  return type === "begin" || type === "move" || type === "end" ? type : null;
}

export class HidTransportRouter {
  private current: "channel" | "socket" = "socket";
  private readonly activeGestureTags = new Set<number>();

  /**
   * Pick the transport — and, on the channel side, the lanes — for one
   * `[tag][JSON]` frame. `inputOpen`/`movesOpen` say which data channels can
   * send right now.
   *
   * - At a gesture boundary (no touch or multi-touch in flight) the router
   *   re-evaluates and prefers the channels when `input` is open.
   * - While a gesture is in flight, every event — including non-gesture tags
   *   like keys, whose order relative to the gesture matters — follows the
   *   gesture's transport.
   * - If the input channel closed under a gesture, the rest of the gesture
   *   falls back to the socket immediately. A closed channel delivers nothing
   *   late, so the switch cannot reorder events.
   * - On the channels, `begin`/`end` go on both lanes, `move`/scroll/crown on
   *   `moves` when it is open, everything else on `input`.
   */
  route(tag: number, payload: object, inputOpen: boolean, movesOpen = false): InputDispatch {
    if (this.activeGestureTags.size === 0) {
      this.current = inputOpen ? "channel" : "socket";
    } else if (this.current === "channel" && !inputOpen) {
      this.current = "socket";
    }

    const phase = touchPhase(tag, payload);
    if (phase === "begin") this.activeGestureTags.add(tag);
    else if (phase === "end") this.activeGestureTags.delete(tag);

    if (this.current === "socket") return { via: "socket" };
    return { via: "channel", lanes: lanesFor(tag, phase, movesOpen) };
  }
}

function lanesFor(
  tag: number,
  phase: "begin" | "move" | "end" | null,
  movesOpen: boolean,
): readonly InputLane[] {
  if (!movesOpen) return ["input"];
  if (phase === "begin" || phase === "end") return ["input", "moves"];
  if (phase === "move" || tag === TAG_SCROLL || tag === TAG_DIGITAL_CROWN) return ["moves"];
  return ["input"];
}

/**
 * Stamps touch and multi-touch messages with a gesture id `g` (incremented per
 * gesture, shared across both tags) and a sequence `s` (0 for `begin`, then +1
 * per event). Other tags pass through untouched. Stamping happens before
 * routing, so the WebSocket fallback carries the same fields and the server
 * runs one code path for every transport.
 */
export class GestureStamper {
  private nextGesture = 1;
  private readonly active = new Map<number, { g: number; s: number }>();

  stamp(tag: number, payload: object): object {
    const phase = touchPhase(tag, payload);
    if (phase === null) return payload;
    if (phase === "begin") {
      const gesture = { g: this.nextGesture++, s: 0 };
      this.active.set(tag, gesture);
      return { ...payload, g: gesture.g, s: gesture.s };
    }
    const gesture = this.active.get(tag);
    // A move or end without a begin (a stale pointer-up after reconnect) is
    // sent unstamped so the server treats it as legacy input.
    if (!gesture) return payload;
    gesture.s += 1;
    if (phase === "end") this.active.delete(tag);
    return { ...payload, g: gesture.g, s: gesture.s };
  }
}

/** The subset of RTCDataChannel the adapter needs; structural so tests need no DOM. */
export type InputChannelLike = {
  readyState: string;
  send(data: ArrayBuffer): void;
};

/**
 * Adapt an open data channel to the `WsSendTarget` shape the shared send queue
 * understands. Returns null unless the channel is open, so callers can treat
 * "no target" and "not open yet" the same way.
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
