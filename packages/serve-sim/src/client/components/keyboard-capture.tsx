import { type RefObject, useEffect, useRef, useState } from "react";
import { Keyboard } from "lucide-react";
import { IconButton } from "./icon-button";
import {
  KEYBOARD_CAPTURE_ATTRIBUTES,
  keyEventsForBeforeInput,
  keyEventsForTextChange,
} from "../utils/mobile-keyboard";
import { readNativeKeyboardRaised } from "../utils/simulator-resize";
import type { KeyEvent } from "../../text-to-keys";

// TEMP on-device keyboard debug overlay.
const kbEv = (events: KeyEvent[]) =>
  events.length
    ? events.map((k) => (k.type === "down" ? "v" : "^") + k.usage.toString(16)).join(" ")
    : "(none)";

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
  const sentRef = useRef("");
  const [dbg, setDbg] = useState("");
  const pushDbg = (line: string) => {
    const w = window as unknown as { __kbdbg?: string[] };
    (w.__kbdbg ??= []).push(line);
    while (w.__kbdbg!.length > 18) w.__kbdbg!.shift();
  };
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const w = window as unknown as { __kbdbg?: string[] };
      setDbg((w.__kbdbg ?? []).join("\n"));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (open) {
      el.value = "";
      sentRef.current = "";
      el.focus();
      pushDbg("OPEN reset+focus");
    } else {
      el.blur();
      pushDbg("CLOSE blur");
    }
  }, [open, inputRef]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const emit = (events: KeyEvent[]) => {
      if (events.length) onKeysRef.current(events);
    };
    const onBeforeInput = (event: Event) => {
      const e = event as InputEvent;
      const events = keyEventsForBeforeInput(e.inputType);
      pushDbg(
        `BI ${e.inputType} d=${JSON.stringify(e.data)} v=${JSON.stringify(el.value)} sel=${el.selectionStart},${el.selectionEnd} -> ${kbEv(events)}`,
      );
      emit(events);
      if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
        e.preventDefault();
      }
    };
    const onInput = () => {
      const events = keyEventsForTextChange(sentRef.current, el.value);
      pushDbg(
        `IN v=${JSON.stringify(el.value)} sel=${el.selectionStart},${el.selectionEnd} sent=${JSON.stringify(sentRef.current)} -> ${kbEv(events)}`,
      );
      emit(events);
      sentRef.current = el.value;
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
    el.addEventListener("input", onInput);
    el.addEventListener("focusout", onFocusOut);
    return () => {
      el.removeEventListener("beforeinput", onBeforeInput);
      el.removeEventListener("input", onInput);
      el.removeEventListener("focusout", onFocusOut);
    };
  }, [inputRef]);

  return (
    <>
      <input
        ref={inputRef}
        className="fixed top-0 left-0 w-px h-px opacity-0 border-none p-0 m-0 bg-transparent"
        aria-hidden
        tabIndex={-1}
        defaultValue=""
        {...KEYBOARD_CAPTURE_ATTRIBUTES}
      />
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 2147483647,
          maxHeight: "40vh",
          overflow: "auto",
          background: "rgba(0,0,0,0.85)",
          color: "#7CFC00",
          font: "10px ui-monospace, monospace",
          padding: "3px 6px",
          whiteSpace: "pre-wrap",
          pointerEvents: "none",
        }}
      >
        {dbg || "kb-debug ready"}
      </div>
    </>
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
