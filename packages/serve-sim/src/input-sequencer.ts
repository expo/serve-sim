/**
 * Ordering guard for touch input that may arrive over more than one channel.
 *
 * On the WebRTC transport a viewer sends `begin`/`end` on both the reliable
 * `input` channel and the lossy `moves` channel, and `move` only on the lossy
 * one (unordered, dropped after ~100 ms rather than retransmitted). That buys
 * back the head-of-line stall a lost move costs on an ordered channel, but it
 * means the server can see duplicates, gaps, and reordering. Every stamped
 * message carries a gesture id `g` (increments per gesture) and a sequence `s`
 * (0 for begin, then +1 per event), and this sequencer applies exactly one of
 * each begin/end and only forward-moving moves of the gesture that is down.
 *
 * Messages without `g`/`s` come from older clients and the CLI; they are
 * applied as-is, but a legacy `begin` still lifts a stamped gesture that is
 * down so the simulator never sees two fingers where the viewer meant one.
 *
 * Pure and framework-free: one instance per touch tag (single and multi-touch
 * gestures are independent), no I/O, unit-tested in isolation.
 */

export type TouchPhase = "begin" | "move" | "end";

export interface SequencedTouch {
  type: TouchPhase;
  /** Gesture id; absent on legacy messages. */
  g?: number;
  /** Sequence within the gesture; absent on legacy messages. */
  s?: number;
  [coordinate: string]: unknown;
}

export type TouchDecision =
  | {
      apply: true;
      /**
       * A gesture that is still down must be lifted before this one starts:
       * its `end` was lost or is still in flight on the reliable channel. The
       * payload is the last applied event of that gesture with `type: "end"`.
       */
      liftFirst?: SequencedTouch;
    }
  | { apply: false; reason: "duplicate" | "stale" | "ended" | "unknown-gesture" };

interface ActiveGesture {
  g: number;
  lastSeq: number;
  ended: boolean;
  last: SequencedTouch;
}

/** How many finished gesture ids to remember so their late copies are dropped. */
const ENDED_GESTURE_MEMORY = 32;

export class TouchSequencer {
  private active: ActiveGesture | null = null;
  private readonly ended: number[] = [];

  decide(message: SequencedTouch): TouchDecision {
    if (typeof message.g !== "number" || typeof message.s !== "number") {
      return this.decideLegacy(message);
    }
    const { g, s } = message;
    switch (message.type) {
      case "begin":
        return this.begin(g, s, message);
      case "move":
        return this.move(g, s, message);
      case "end":
        return this.end(g, s, message);
      default:
        return { apply: true };
    }
  }

  private decideLegacy(message: SequencedTouch): TouchDecision {
    const active = this.active;
    if (message.type === "begin" && active && !active.ended) {
      // A stamped gesture is still down. Lift it so the legacy tap does not
      // register as a second finger; the stamped gesture's own late events are
      // dropped from here on.
      this.rememberEnded(active.g);
      this.active = null;
      return { apply: true, liftFirst: { ...active.last, type: "end" } };
    }
    if (message.type === "end" && active && !active.ended) {
      this.rememberEnded(active.g);
      this.active = null;
    }
    return { apply: true };
  }

  private begin(g: number, s: number, message: SequencedTouch): TouchDecision {
    const active = this.active;
    if (active?.g === g) return { apply: false, reason: "duplicate" };
    if (this.ended.includes(g)) return { apply: false, reason: "ended" };
    const decision: TouchDecision = { apply: true };
    if (active && !active.ended) {
      // Its end is lost or late: lift it at its last position so the new
      // finger is the only one down.
      this.rememberEnded(active.g);
      decision.liftFirst = { ...active.last, type: "end" };
    }
    this.active = { g, lastSeq: s, ended: false, last: message };
    return decision;
  }

  private move(g: number, s: number, message: SequencedTouch): TouchDecision {
    const active = this.active;
    if (!active || active.g !== g) {
      // Either the begin has not arrived yet (it will, on the reliable
      // channel) or this is a straggler from an older gesture.
      return { apply: false, reason: this.ended.includes(g) ? "ended" : "unknown-gesture" };
    }
    if (active.ended) return { apply: false, reason: "ended" };
    if (s <= active.lastSeq) return { apply: false, reason: "stale" };
    active.lastSeq = s;
    active.last = message;
    return { apply: true };
  }

  private end(g: number, s: number, message: SequencedTouch): TouchDecision {
    const active = this.active;
    if (active?.g === g) {
      if (active.ended) return { apply: false, reason: "duplicate" };
      active.ended = true;
      active.lastSeq = Math.max(active.lastSeq, s);
      active.last = message;
      this.rememberEnded(g);
      return { apply: true };
    }
    if (this.ended.includes(g)) return { apply: false, reason: "duplicate" };
    // An end for a gesture whose begin never arrived: nothing is down for it,
    // so there is nothing to lift, but its late begin must not start a finger
    // that would never be lifted.
    this.rememberEnded(g);
    return { apply: false, reason: "unknown-gesture" };
  }

  private rememberEnded(g: number): void {
    if (this.ended.includes(g)) return;
    this.ended.push(g);
    if (this.ended.length > ENDED_GESTURE_MEMORY) this.ended.shift();
  }
}
