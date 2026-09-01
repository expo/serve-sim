import { textToKeyEventsLenient, type KeyEvent } from "../../text-to-keys";
import { hidUsageForCode } from "./hid";

const BACKSPACE = hidUsageForCode("Backspace")!;
const ENTER = hidUsageForCode("Enter")!;

function press(usage: number): KeyEvent[] {
  return [{ type: "down", usage }, { type: "up", usage }];
}

export type KeyboardInputOutcome = { events: KeyEvent[]; skipped: string[] };

// Soft keyboards are read through `beforeinput`, not `keydown`: iOS delivers
// soft keys with an empty `code`, which the physical-key relay drops. The
// inputType tells us what the key meant, which is what we forward.
export function keyEventsForInputType(
  inputType: string,
  data: string | null,
): KeyboardInputOutcome {
  switch (inputType) {
    case "insertText":
    case "insertCompositionText":
    case "insertFromPaste":
      return data ? textToKeyEventsLenient(data) : { events: [], skipped: [] };
    case "insertLineBreak":
    case "insertParagraph":
      return { events: press(ENTER), skipped: [] };
    case "deleteContentBackward":
    case "deleteWordBackward":
      return { events: press(BACKSPACE), skipped: [] };
    default:
      return { events: [], skipped: [] };
  }
}

/** Attributes that stop iOS from autocapitalising and autocorrecting what goes to the device. */
export const KEYBOARD_CAPTURE_ATTRIBUTES = {
  autoCapitalize: "none",
  autoCorrect: "off",
  autoComplete: "off",
  spellCheck: false,
} as const;
