import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { RESIZE_MAIN_STROKE } from "../utils/simulator-resize";

/** Floating hardware control, with balanced native presses even if the view
 * is hidden or unmounted while a button is held.
 */
export function DuoDeviceButton({ label, children, onPress, disabled }: {
  label: string;
  children: ReactNode;
  onPress?: (phase: "down" | "up") => void;
  disabled?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focused, setFocused] = useState(false);
  const active = useRef<{ element: HTMLButtonElement; pointerId?: number; send?: typeof onPress } | null>(null);
  const release = useCallback(() => {
    const held = active.current;
    if (!held) return;
    active.current = null;
    held.send?.("up");
    if (held.pointerId !== undefined && held.element.hasPointerCapture(held.pointerId)) held.element.releasePointerCapture(held.pointerId);
    setPressed(false);
  }, []);
  const press = (element: HTMLButtonElement, pointerId?: number) => {
    if (disabled || !onPress || active.current) return;
    active.current = { element, pointerId, send: onPress };
    if (pointerId !== undefined) {
      try { element.setPointerCapture(pointerId); } catch {}
    }
    setPressed(true);
    onPress?.("down");
  };
  useEffect(() => {
    const hidden = () => { if (document.hidden) release(); };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", hidden);
      release();
    };
  }, [release]);
  useEffect(() => { if (disabled) release(); }, [disabled, release]);

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled || !onPress}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        press(event.currentTarget, event.pointerId);
      }}
      onPointerUp={(event) => { if (active.current?.pointerId === event.pointerId) release(); }}
      onPointerCancel={(event) => { if (active.current?.pointerId === event.pointerId) release(); }}
      onLostPointerCapture={(event) => { if (active.current?.pointerId === event.pointerId) release(); }}
      onFocus={(event) => setFocused(event.currentTarget.matches(":focus-visible"))}
      onBlur={() => { setFocused(false); release(); }}
      onKeyDown={(event) => {
        if (!onPress || (event.key !== " " && event.key !== "Enter")) return;
        event.preventDefault();
        event.stopPropagation();
        press(event.currentTarget);
      }}
      onKeyUp={(event) => {
        if (!onPress || (event.key !== " " && event.key !== "Enter")) return;
        event.preventDefault();
        event.stopPropagation();
        release();
      }}
      onClick={(event) => {
        event.stopPropagation();
        // Keyboard/screen-reader activation can arrive without pointer events.
        if (!disabled && onPress && !active.current && event.detail === 0) { onPress("down"); onPress("up"); }
      }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", width: 44, height: 44,
        padding: 0, border: 0, borderRadius: 10, background: "transparent",
        color: RESIZE_MAIN_STROKE[pressed ? "drag" : hovered || focused ? "hover" : "idle"],
        outline: focused ? "2px solid #0a84ff" : "none", outlineOffset: -5,
        cursor: "pointer", touchAction: "none", WebkitTapHighlightColor: "transparent",
        visibility: disabled || !onPress ? "hidden" : undefined,
      }}
    >
      <span aria-hidden="true" style={{ display: "flex", pointerEvents: "none", transform: "rotate(calc(-1 * var(--duo-control-rotation, 0rad)))" }}>{children}</span>
    </button>
  );
}
