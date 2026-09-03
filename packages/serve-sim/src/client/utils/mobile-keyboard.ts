import { textToKeyEventsLenient, type KeyEvent } from "../../text-to-keys";
import { hidUsageForCode } from "./hid";

const BACKSPACE = hidUsageForCode("Backspace")!;
const ENTER = hidUsageForCode("Enter")!;

function press(usage: number): KeyEvent[] {
  return [{ type: "down", usage }, { type: "up", usage }];
}

export function keyEventsForInputType(
  inputType: string,
  data: string | null,
): KeyEvent[] {
  switch (inputType) {
    case "insertText":
    case "insertFromPaste":
      return data != null && data !== ""
        ? textToKeyEventsLenient(data).events
        : [];
    case "insertLineBreak":
    case "insertParagraph":
      return press(ENTER);
    case "deleteContentBackward":
    case "deleteWordBackward":
      return press(BACKSPACE);
    default:
      return [];
  }
}

export function compositionDeltaKeyEvents(
  previous: string,
  next: string,
): KeyEvent[] {
  const prev = Array.from(previous);
  const cur = Array.from(next);
  let common = 0;
  const max = Math.min(prev.length, cur.length);
  while (common < max && prev[common] === cur[common]) common++;
  const events: KeyEvent[] = [];
  for (let i = common; i < prev.length; i++) events.push(...press(BACKSPACE));
  events.push(...textToKeyEventsLenient(cur.slice(common).join("")).events);
  return events;
}

export const KEYBOARD_CAPTURE_ATTRIBUTES = {
  autoCapitalize: "none",
  autoCorrect: "off",
  autoComplete: "off",
  spellCheck: false,
} as const;
