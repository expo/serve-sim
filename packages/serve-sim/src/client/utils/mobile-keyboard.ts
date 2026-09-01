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
    case "insertCompositionText":
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

/** Attributes that stop iOS from autocapitalising and autocorrecting what goes to the device. */
export const KEYBOARD_CAPTURE_ATTRIBUTES = {
  autoCapitalize: "none",
  autoCorrect: "off",
  autoComplete: "off",
  spellCheck: false,
} as const;
