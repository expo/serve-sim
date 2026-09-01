import { describe, expect, test } from "bun:test";
import { keyEventsForInputType } from "../client/utils/mobile-keyboard";
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
