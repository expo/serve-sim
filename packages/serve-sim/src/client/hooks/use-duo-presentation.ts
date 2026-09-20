import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { duoDisplayForHingeAngle, type DuoDisplay } from "../../hinge-angle";
import { DUO_SETTLE_MS, duoPose, duoSliderPose, duoTransition, interpolateDuoPose } from "../utils/duo-motion";

type Phase = "idle" | "waiting" | "moving";

export function useDuoPresentation(target: number, pending: boolean, root: RefObject<HTMLDivElement | null>, motion: "animate" | "direct" = "animate") {
  const initialDisplay = duoDisplayForHingeAngle(target);
  const [display, setDisplay] = useState<DuoDisplay>(initialDisplay);
  const displayRef = useRef(display);
  const [pose, setPose] = useState(() => motion === "direct" ? duoSliderPose(target, initialDisplay) : duoPose(target));
  const [holding, setHolding] = useState<DuoDisplay | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const current = useRef(pose);
  const nativePending = useRef(pending);
  nativePending.current = pending;
  useLayoutEffect(() => {
    const from = current.current;
    const outgoing = displayRef.current;
    const incoming = motion === "direct" ? duoDisplayForHingeAngle(target, outgoing) : target === 0 ? "cover" : "inner";
    const to = motion === "direct" ? duoSliderPose(target, incoming) : duoPose(target);
    const handoff = outgoing !== incoming && !!root.current?.querySelector('canvas[data-stream-codec="webrtc"]');
    const requestedAt = performance.now();
    let start: number | undefined;
    let raf = 0;
    const transition = duoTransition(from, to);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setHolding(handoff ? outgoing : null);
    setPhase(handoff ? "waiting" : "moving");
    const destinationReady = (now: number) => {
      const canvas = root.current?.querySelector<HTMLCanvasElement>(`[data-duo-panel="${incoming}"] canvas[data-stream-codec="webrtc"]`);
      if (!canvas) return false;
      if (canvas.dataset.duoFrameAt) return true;
      return !nativePending.current && now - requestedAt >= 2000
        && Number(canvas.dataset.duoDecodedAt ?? 0) > requestedAt;
    };
    const step = (now: number) => {
      if (start === undefined) {
        if (handoff && !destinationReady(now)) { raf = requestAnimationFrame(step); return; }
        start = now;
        if (displayRef.current !== incoming) {
          displayRef.current = incoming;
          setDisplay(incoming);
        }
        setPhase("moving");
      }
      const t = reduced ? 1 : Math.min(1, (now - start) / transition.duration);
      const eased = transition.ease(t);
      current.current = t === 1 ? to : interpolateDuoPose(from, to, eased);
      setPose(current.current);
      if (t < 1) raf = requestAnimationFrame(step);
      else {
        const canvas = root.current?.querySelector<HTMLCanvasElement>(`[data-duo-panel="${incoming}"] canvas[data-stream-codec="webrtc"]`);
        const fresh = Number(canvas?.dataset.duoFrameAt ?? 0) > requestedAt;
        const lcdSettling = motion === "direct" && now - start < DUO_SETTLE_MS;
        if (lcdSettling || nativePending.current || (handoff && !fresh && now - requestedAt < 2000)) {
          raf = requestAnimationFrame(step);
        } else { setHolding(null); setPhase("idle"); }
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, root, motion]);
  return { pose, holding, phase, display };
}
