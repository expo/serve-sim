import { type RefObject, useEffect, useRef } from "react";
import { Keyboard, KeyboardOff } from "lucide-react";
import { IconButton } from "./icon-button";
import {
  KEYBOARD_CAPTURE_ATTRIBUTES,
  keyEventsForInputType,
} from "../utils/mobile-keyboard";
import type { KeyEvent } from "../../text-to-keys";

/**
 * Touch devices never deliver key events to the page: a soft keyboard only
 * appears for a focused editable element, and the keys it does send arrive with
 * an empty `code`, which the physical-key relay drops. This focuses a real (but
 * invisible) field so the OS raises its keyboard, then forwards what the user
 * types as HID key events.
 */
export function KeyboardCapture({
  open,
  onKeys,
  inputRef,
}: {
  open: boolean;
  onKeys: (events: KeyEvent[]) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const ownRef = useRef<HTMLInputElement | null>(null);
  const ref = inputRef ?? ownRef;
  const onKeysRef = useRef(onKeys);
  onKeysRef.current = onKeys;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) el.focus();
    else el.blur();
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Native listener, not React's `onBeforeInput`: the synthetic event is not
    // the DOM one and does not carry `inputType`, which is the whole signal.
    const onBeforeInput = (event: Event) => {
      const e = event as InputEvent;
      const { events } = keyEventsForInputType(e.inputType, e.data);
      if (events.length) onKeysRef.current(events);
      e.preventDefault();
    };
    // iOS drops focus for its own reasons while the keyboard animates and the
    // viewport reflows. Losing it would tear the keyboard down mid-sentence, so
    // focus follows the user's intent, not the browser's.
    const onFocusOut = () => {
      if (!openRef.current) return;
      queueMicrotask(() => {
        if (openRef.current && document.activeElement !== el) el.focus();
      });
    };
    el.addEventListener("beforeinput", onBeforeInput);
    el.addEventListener("focusout", onFocusOut);
    return () => {
      el.removeEventListener("beforeinput", onBeforeInput);
      el.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  // Always mounted: unmounting it on close destroyed the focused element, which
  // is what dismissed the keyboard after a single keystroke.
  return (
    <input
      ref={ref}
      // Offscreen elements get scrolled into view on focus, so it stays in the
      // viewport and is hidden by being transparent and zero-sized instead.
      className="fixed top-0 left-0 w-px h-px opacity-0 border-none p-0 m-0 bg-transparent"
      aria-hidden
      tabIndex={-1}
      defaultValue=""
      {...KEYBOARD_CAPTURE_ATTRIBUTES}
    />
  );
}

export function KeyboardToggleButton({
  open,
  onClick,
}: {
  open: boolean;
  onClick: () => void;
}) {
  return (
    <IconButton
      onClick={onClick}
      aria-label="Keyboard"
      aria-pressed={open}
      title="Keyboard"
    >
      <Keyboard size={18} strokeWidth={1.75} />
    </IconButton>
  );
}

/**
 * Toggles the simulator's own on-screen keyboard, which otherwise covers the
 * device while you type on the host keyboard. The underlying HID press is a
 * blind toggle with no readable state, so this is a manual control rather than
 * something driven automatically.
 */
export function SimKeyboardToggleButton({ onClick }: { onClick: () => void }) {
  return (
    <IconButton
      onClick={onClick}
      aria-label="Toggle simulator keyboard"
      title="Toggle simulator keyboard"
    >
      <KeyboardOff size={18} strokeWidth={1.75} />
    </IconButton>
  );
}
