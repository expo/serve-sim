import { describe, expect, test } from "bun:test";
import {
  keyEventsForBeforeInput,
  keyEventsForInputType,
  keyEventsForTextChange,
} from "../client/utils/mobile-keyboard";
import { textToKeyEventsLenient } from "../text-to-keys";

describe("textToKeyEventsLenient", () => {
  test("skips characters the US map can't reach instead of dropping the string", () => {
    const { events, skipped } = textToKeyEventsLenient("hi🎉!");

    expect(skipped).toEqual(["🎉"]);
    // h, i and ! still made it, with ! shifted.
    expect(events.length).toBeGreaterThan(0);
    expect(textToKeyEventsLenient("hi!").events).toEqual(events);
  });
});

describe("keyEventsForInputType", () => {
  test("types inserted text", () => {
    const events = keyEventsForInputType("insertText", "a");

    expect(events).toEqual([
      { type: "down", usage: 0x04 },
      { type: "up", usage: 0x04 },
    ]);
  });

  test("maps the editing intents a soft keyboard reports", () => {
    const enter = keyEventsForInputType("insertLineBreak", null);
    const back = keyEventsForInputType("deleteContentBackward", null);

    expect(enter).toEqual([
      { type: "down", usage: 0x28 },
      { type: "up", usage: 0x28 },
    ]);
    expect(back).toEqual([
      { type: "down", usage: 0x2a },
      { type: "up", usage: 0x2a },
    ]);
  });

  test("ignores intents that carry no keystroke", () => {
    expect(keyEventsForInputType("historyUndo", null)).toEqual([]);
    expect(keyEventsForInputType("insertText", null)).toEqual([]);
  });
});

describe("keyEventsForTextChange", () => {
  const BACKSPACE = {
    down: { type: "down", usage: 0x2a },
    up: { type: "up", usage: 0x2a },
  } as const;

  test("forwards only the newly typed characters across updates", () => {
    let sent = "";
    const emitted = [];
    for (const next of ["h", "he", "hel"]) {
      emitted.push(...keyEventsForTextChange(sent, next));
      sent = next;
    }

    // Typing "h" -> "he" -> "hel" types "hel" once, not "hhhehel".
    expect(emitted).toEqual(textToKeyEventsLenient("hel").events);
  });

  test("backspaces the replaced tail when a suggestion swaps the word", () => {
    // "helo" gets replaced by the "hello" suggestion.
    const events = keyEventsForTextChange("helo", "hello");

    // Common prefix "hel"; delete the trailing "o", then type "lo".
    expect(events).toEqual([BACKSPACE.down, BACKSPACE.up, ...textToKeyEventsLenient("lo").events]);
  });

  test("replaces a whole mistyped word", () => {
    const events = keyEventsForTextChange("teh", "the");

    // Common prefix ""... actually "t"; delete "eh", type "he".
    expect(events).toEqual([
      BACKSPACE.down,
      BACKSPACE.up,
      BACKSPACE.down,
      BACKSPACE.up,
      ...textToKeyEventsLenient("he").events,
    ]);
  });

  test("skips an inserted emoji without keystrokes", () => {
    expect(keyEventsForTextChange("", "😀")).toEqual([]);
  });

  test("does not backspace for an emoji that was never sent", () => {
    // "a😀" -> "a": the emoji leaves the value but was never a keystroke.
    expect(keyEventsForTextChange("a😀", "a")).toEqual([]);
  });
});

describe("keyEventsForBeforeInput", () => {
  const BACKSPACE = {
    down: { type: "down", usage: 0x2a },
    up: { type: "up", usage: 0x2a },
  } as const;

  test("forwards Backspace for a delete on an empty input (caret at start)", () => {
    expect(keyEventsForBeforeInput("deleteContentBackward", true)).toEqual([
      BACKSPACE.down,
      BACKSPACE.up,
    ]);
    expect(keyEventsForBeforeInput("deleteWordBackward", true)).toEqual([
      BACKSPACE.down,
      BACKSPACE.up,
    ]);
  });

  test("leaves a delete to the value diff when the caret is not at the start", () => {
    expect(keyEventsForBeforeInput("deleteContentBackward", false)).toEqual([]);
  });

  test("still sends Backspace after the keyboard is closed and reopened", () => {
    const sent: { type: string; usage: number }[] = [];
    let buffer = "";
    for (const next of ["h", "hi"]) {
      sent.push(...keyEventsForTextChange(buffer, next));
      buffer = next;
    }

    // Closing then reopening the keyboard clears the hidden input and its buffer.
    buffer = "";
    // The value diff alone forwards nothing for a Backspace on the empty input...
    expect(keyEventsForTextChange(buffer, buffer)).toEqual([]);
    // ...but the beforeinput handler still forwards it to the sim.
    const afterReopen = keyEventsForBeforeInput("deleteContentBackward", true);
    sent.push(...afterReopen);

    expect(afterReopen).toEqual([BACKSPACE.down, BACKSPACE.up]);
    expect(sent.slice(-2)).toEqual([BACKSPACE.down, BACKSPACE.up]);
  });
});
