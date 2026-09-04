import { describe, expect, test } from "bun:test";
import { TouchSequencer, type SequencedTouch } from "../input-sequencer";

function begin(g: number, x = 0.5, y = 0.5): SequencedTouch {
  return { type: "begin", g, s: 0, x, y };
}
function move(g: number, s: number, x = 0.5, y = 0.5): SequencedTouch {
  return { type: "move", g, s, x, y };
}
function end(g: number, s: number, x = 0.5, y = 0.5): SequencedTouch {
  return { type: "end", g, s, x, y };
}

describe("TouchSequencer", () => {
  test("applies a well-ordered gesture unchanged", () => {
    const sequencer = new TouchSequencer();
    expect(sequencer.decide(begin(1))).toEqual({ apply: true });
    expect(sequencer.decide(move(1, 1))).toEqual({ apply: true });
    expect(sequencer.decide(move(1, 2))).toEqual({ apply: true });
    expect(sequencer.decide(end(1, 3))).toEqual({ apply: true });
  });

  test("drops the second copy of a dual-sent begin and end", () => {
    // begin/end travel on both the reliable and the lossy channel; whichever
    // copy lands first is the one that counts.
    const sequencer = new TouchSequencer();
    expect(sequencer.decide(begin(1))).toEqual({ apply: true });
    expect(sequencer.decide(begin(1))).toEqual({ apply: false, reason: "duplicate" });
    expect(sequencer.decide(end(1, 4))).toEqual({ apply: true });
    expect(sequencer.decide(end(1, 4))).toEqual({ apply: false, reason: "duplicate" });
  });

  test("drops moves that arrive out of order or after a newer move", () => {
    const sequencer = new TouchSequencer();
    sequencer.decide(begin(1));
    expect(sequencer.decide(move(1, 3))).toEqual({ apply: true });
    // Reordered by the unordered channel: an older move must not drag the
    // finger backwards.
    expect(sequencer.decide(move(1, 2))).toEqual({ apply: false, reason: "stale" });
    expect(sequencer.decide(move(1, 3))).toEqual({ apply: false, reason: "stale" });
    expect(sequencer.decide(move(1, 4))).toEqual({ apply: true });
  });

  test("drops moves that straggle in after the gesture ended", () => {
    const sequencer = new TouchSequencer();
    sequencer.decide(begin(1));
    sequencer.decide(end(1, 5));
    // A late move after the finger lifted would be a phantom drag.
    expect(sequencer.decide(move(1, 3))).toEqual({ apply: false, reason: "ended" });
  });

  test("drops moves for a gesture whose begin has not arrived", () => {
    // The lossy copy of begin was lost; the reliable copy is still in flight.
    // Moving a finger that is not down is dropped, not buffered.
    const sequencer = new TouchSequencer();
    expect(sequencer.decide(move(7, 1))).toEqual({ apply: false, reason: "unknown-gesture" });
    expect(sequencer.decide(begin(7))).toEqual({ apply: true });
    expect(sequencer.decide(move(7, 2))).toEqual({ apply: true });
  });

  test("lifts a finger whose end was lost before a new gesture begins", () => {
    const sequencer = new TouchSequencer();
    sequencer.decide(begin(1, 0.2, 0.2));
    sequencer.decide(move(1, 1, 0.3, 0.4));
    // Gesture 1's end never arrived. Gesture 2 must start with one finger
    // down, so gesture 1 is ended at its last known position first.
    expect(sequencer.decide(begin(2, 0.8, 0.8))).toEqual({
      apply: true,
      liftFirst: { type: "end", g: 1, s: 1, x: 0.3, y: 0.4 },
    });
    // The lost end finally arrives on the reliable channel: already lifted.
    expect(sequencer.decide(end(1, 2))).toEqual({ apply: false, reason: "duplicate" });
    expect(sequencer.decide(move(2, 1))).toEqual({ apply: true });
  });

  test("an end that beats its own begin leaves nothing down and cancels the late begin", () => {
    // Reliable begin still in flight, lossy end arrived first: nothing is
    // down for gesture 3, and when its begin does land it must not start a
    // finger that nothing will ever lift.
    const sequencer = new TouchSequencer();
    expect(sequencer.decide(end(3, 2))).toEqual({ apply: false, reason: "unknown-gesture" });
    expect(sequencer.decide(begin(3))).toEqual({ apply: false, reason: "ended" });
    expect(sequencer.decide(move(3, 1))).toEqual({ apply: false, reason: "ended" });
    // The next gesture is unaffected.
    expect(sequencer.decide(begin(4))).toEqual({ apply: true });
  });

  test("applies unstamped legacy messages as they are", () => {
    const sequencer = new TouchSequencer();
    expect(sequencer.decide({ type: "begin", x: 0.1, y: 0.1 })).toEqual({ apply: true });
    expect(sequencer.decide({ type: "move", x: 0.2, y: 0.2 })).toEqual({ apply: true });
    expect(sequencer.decide({ type: "end", x: 0.2, y: 0.2 })).toEqual({ apply: true });
  });

  test("a legacy begin lifts a stamped gesture that is still down", () => {
    const sequencer = new TouchSequencer();
    sequencer.decide(begin(1, 0.5, 0.5));
    expect(sequencer.decide({ type: "begin", x: 0.1, y: 0.1 })).toEqual({
      apply: true,
      liftFirst: { type: "end", g: 1, s: 0, x: 0.5, y: 0.5 },
    });
    // The stamped gesture's stragglers are ignored from here on.
    expect(sequencer.decide(move(1, 1))).toEqual({ apply: false, reason: "ended" });
  });

  test("keeps multi-touch coordinates intact when lifting", () => {
    const sequencer = new TouchSequencer();
    sequencer.decide({ type: "begin", g: 1, s: 0, x1: 0.2, y1: 0.2, x2: 0.8, y2: 0.8 });
    expect(sequencer.decide({ type: "begin", g: 2, s: 0, x1: 0.3, y1: 0.3, x2: 0.7, y2: 0.7 })).toEqual({
      apply: true,
      liftFirst: { type: "end", g: 1, s: 0, x1: 0.2, y1: 0.2, x2: 0.8, y2: 0.8 },
    });
  });

  test("forgets old ended gestures so ids can be reused after a long session", () => {
    const sequencer = new TouchSequencer();
    for (let g = 1; g <= 40; g++) {
      sequencer.decide(begin(g));
      sequencer.decide(end(g, 1));
    }
    // Gesture 1 has aged out of the ended set; a fresh gesture reusing the id
    // (a reloaded page restarts its counter) is accepted.
    expect(sequencer.decide(begin(1))).toEqual({ apply: true });
  });
});
