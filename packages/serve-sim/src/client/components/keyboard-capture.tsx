import { type RefObject, useEffect, useRef } from "react";
import { Keyboard } from "lucide-react";
import { IconButton } from "./icon-button";
import {
  KEYBOARD_CAPTURE_ATTRIBUTES,
  compositionDeltaKeyEvents,
  keyEventsForInputType,
} from "../utils/mobile-keyboard";
import { readNativeKeyboardRaised } from "../utils/simulator-resize";
import type { KeyEvent } from "../../text-to-keys";

export function KeyboardCapture({
  open,
  onKeys,
  inputRef,
}: {
  open: boolean;
  onKeys: (events: KeyEvent[]) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const onKeysRef = useRef(onKeys);
  onKeysRef.current = onKeys;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (open) el.focus();
    else el.blur();
  }, [open, inputRef]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    let composition = "";
    const emit = (events: KeyEvent[]) => {
      if (events.length) onKeysRef.current(events);
    };
    const onBeforeInput = (event: Event) => {
      const e = event as InputEvent;
      if (e.inputType === "insertCompositionText") {
        const next = e.data ?? "";
        emit(compositionDeltaKeyEvents(composition, next));
        composition = next;
        return;
      }
      emit(keyEventsForInputType(e.inputType, e.data));
      e.preventDefault();
    };
    const onCompositionStart = () => {
      composition = "";
    };
    const onCompositionEnd = (event: Event) => {
      const e = event as CompositionEvent;
      emit(compositionDeltaKeyEvents(composition, e.data ?? ""));
      composition = "";
    };
    const onFocusOut = () => {
      if (!openRef.current) return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!openRef.current || document.activeElement === el) return;
          if (readNativeKeyboardRaised()) el.focus();
        });
      });
    };
    el.addEventListener("beforeinput", onBeforeInput);
    el.addEventListener("compositionstart", onCompositionStart);
    el.addEventListener("compositionend", onCompositionEnd);
    el.addEventListener("focusout", onFocusOut);
    return () => {
      el.removeEventListener("beforeinput", onBeforeInput);
      el.removeEventListener("compositionstart", onCompositionStart);
      el.removeEventListener("compositionend", onCompositionEnd);
      el.removeEventListener("focusout", onFocusOut);
    };
  }, [inputRef]);

  return (
    <input
      ref={inputRef}
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
