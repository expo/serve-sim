import { useEffect } from "react";

const GESTURE_EVENTS = ["gesturestart", "gesturechange", "gestureend"] as const;

/**
 * iOS Safari ignores `user-scalable=no`, so pinching the page still zooms the
 * whole preview. Only the page-level gesture events are cancelled; touch events
 * are left alone because the simulator needs them.
 */
export function useBlockPageZoom(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const prevent = (event: Event) => event.preventDefault();
    for (const name of GESTURE_EVENTS) {
      document.addEventListener(name, prevent, { passive: false });
    }
    return () => {
      for (const name of GESTURE_EVENTS) document.removeEventListener(name, prevent);
    };
  }, [enabled]);
}
