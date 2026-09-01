import { useEffect, useRef } from "react";
import { Keyboard } from "lucide-react";
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
  onClose,
}: {
  open: boolean;
  onKeys: (events: KeyEvent[]) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const onKeysRef = useRef(onKeys);
  onKeysRef.current = onKeys;

  useEffect(() => {
    const el = ref.current;
    if (!el || !open) return;
    el.focus();
    // Native listener, not React's `onBeforeInput`: the synthetic event is not
    // the DOM one and does not carry `inputType`, which is the whole signal.
    const onBeforeInput = (event: Event) => {
      const e = event as InputEvent;
      const { events } = keyEventsForInputType(e.inputType, e.data);
      if (events.length) onKeysRef.current(events);
      e.preventDefault();
    };
    el.addEventListener("beforeinput", onBeforeInput);
    return () => el.removeEventListener("beforeinput", onBeforeInput);
  }, [open]);

  if (!open) return null;

  return (
    <input
      ref={ref}
      // Offscreen elements get scrolled into view on focus, so it stays in the
      // viewport and is hidden by being transparent and zero-sized instead.
      className="fixed top-0 left-0 w-px h-px opacity-0 border-none p-0 m-0 bg-transparent"
      aria-hidden
      tabIndex={-1}
      defaultValue=""
      onBlur={onClose}
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
    <button
      onClick={onClick}
      className="w-[30px] h-[30px] flex items-center justify-center bg-transparent border-none rounded-md text-[#8e8e93] cursor-pointer [transition:background_0.15s_ease,color_0.15s_ease] hover:bg-white/8 hover:text-white"
      aria-label="Keyboard"
      aria-pressed={open}
      title="Keyboard"
    >
      <Keyboard size={18} strokeWidth={1.75} />
    </button>
  );
}
