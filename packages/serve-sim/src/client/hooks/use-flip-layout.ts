import { useLayoutEffect, useRef, type RefObject } from "react";
import type { SimulatorOrientation } from "../types";
import { shortestRotationDelta } from "../simulator/orientation";
import {
  FOLD_POSE_TRANSITION,
  FOLD_POSE_TRANSITION_MS,
  SIMULATOR_RESIZE_PRESENTATION_TRANSITION,
  SIMULATOR_RESIZE_PRESENTATION_TRANSITION_MS,
} from "../utils/simulator-resize";

type FlipRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

function normalize180(degrees: number): number {
  let delta = degrees % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function isQuarterOrHalfTurn(degrees: number): boolean {
  const abs = Math.abs(normalize180(degrees));
  return Math.abs(abs - 90) < 1 || Math.abs(abs - 180) < 1;
}

export function flipLayoutInvert(
  prev: FlipRect,
  next: FlipRect,
  rotationDegrees = 0,
): { transform: string; transformOrigin: string } | null {
  if (prev.width < 1 || next.width < 1 || prev.height < 1 || next.height < 1) return null;

  if (isQuarterOrHalfTurn(rotationDegrees)) {
    const dx = prev.left + prev.width / 2 - (next.left + next.width / 2);
    const dy = prev.top + prev.height / 2 - (next.top + next.height / 2);
    const scale = Math.hypot(prev.width, prev.height) / Math.hypot(next.width, next.height);
    const rotate = -normalize180(rotationDegrees);
    if (
      Math.abs(dx) < 0.5 &&
      Math.abs(dy) < 0.5 &&
      Math.abs(scale - 1) < 0.002 &&
      Math.abs(rotate) < 0.5
    ) {
      return null;
    }
    return {
      transformOrigin: "50% 50%",
      transform: `translate(${dx}px, ${dy}px) rotate(${rotate}deg) scale(${scale})`,
    };
  }

  const dx = prev.left - next.left;
  const dy = prev.top - next.top;
  const sx = prev.width / next.width;
  const sy = prev.height / next.height;
  if (
    Math.abs(dx) < 0.5 &&
    Math.abs(dy) < 0.5 &&
    Math.abs(sx - 1) < 0.002 &&
    Math.abs(sy - 1) < 0.002
  ) {
    return null;
  }
  return {
    transformOrigin: "0 0",
    transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
  };
}

export function useFlipLayout(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  layoutWidth: number,
  layoutHeight: number,
  viewportHeight: number,
  phoneKeyboardRaised: boolean,
  scaling: boolean,
  orientation?: SimulatorOrientation | null,
) {
  const prevRef = useRef<DOMRectReadOnly | null>(null);
  const prevOrientationRef = useRef(orientation);
  const playingRef = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (playingRef.current) return;

    const next = el.getBoundingClientRect();
    const prev = prevRef.current;
    const fromOrientation = prevOrientationRef.current;
    prevRef.current = next;
    prevOrientationRef.current = orientation;
    if (!enabled || prev == null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const rotation = shortestRotationDelta(fromOrientation, orientation);
    const invert = flipLayoutInvert(prev, next, rotation);
    if (!invert) return;

    playingRef.current = true;
    el.style.transition = "none";
    el.style.transformOrigin = invert.transformOrigin;
    el.style.transform = invert.transform;
    void el.getBoundingClientRect();

    const motion = isQuarterOrHalfTurn(rotation)
      ? FOLD_POSE_TRANSITION
      : SIMULATOR_RESIZE_PRESENTATION_TRANSITION;
    const durationMs = isQuarterOrHalfTurn(rotation)
      ? FOLD_POSE_TRANSITION_MS
      : SIMULATOR_RESIZE_PRESENTATION_TRANSITION_MS;
    const animationFrame = requestAnimationFrame(() => {
      el.style.transition = motion;
      el.style.transform = "translate(0px, 0px) rotate(0deg) scale(1)";
    });

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      playingRef.current = false;
      el.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timeout);
      el.style.transition = "";
      el.style.transform = "";
      el.style.transformOrigin = "";
      prevRef.current = el.getBoundingClientRect();
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target !== el || event.propertyName !== "transform") return;
      finish();
    };
    el.addEventListener("transitionend", onEnd);
    const timeout = window.setTimeout(finish, durationMs + 80);
    return () => {
      const visualRect = el.getBoundingClientRect();
      cancelAnimationFrame(animationFrame);
      finish();
      prevRef.current = visualRect;
    };
  }, [
    enabled,
    layoutHeight,
    layoutWidth,
    orientation,
    phoneKeyboardRaised,
    ref,
    scaling,
    viewportHeight,
  ]);
}
