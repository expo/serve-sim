import { duoDisplayForHingeAngle, foldLeafYaw, INNER_BOOK_HALF_DEG, type DuoDisplay } from "../../hinge-angle";

export const DUO_SETTLE_MS = 1100;
const INNER_SETTLE_MS = 500;

function coverEase(progress: number): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const t = Math.max(0, progress * 1.4 - 0.02);
  const damping = 1.56, frequency = 17.4;
  const root = Math.sqrt(damping * damping - 1);
  const slow = frequency * (damping - root), fast = frequency * (damping + root);
  return 1 - (fast * Math.exp(-slow * t) - slow * Math.exp(-fast * t)) / (fast - slow);
}

function smoothstep(progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  return t * t * (3 - 2 * t);
}

export function duoTransition(from: DuoPose, to: DuoPose) {
  if (from.leftYaw <= 90 && to.leftYaw <= 90) {
    return { duration: INNER_SETTLE_MS, ease: smoothstep };
  }
  const distance = Math.abs(to.leftYaw - from.leftYaw) / 180;
  return {
    duration: Math.max(100, DUO_SETTLE_MS * Math.min(1, Math.sqrt(distance / 0.8))),
    ease: to.leftYaw <= from.leftYaw ? coverEase : smoothstep,
  };
}

type DuoPose = { angle: number; leftYaw: number; rightYaw: number; offset: number };
export function duoPose(angle: number): DuoPose {
  const half = Math.min(1, angle / 90);
  const yaw = angle < 90 ? INNER_BOOK_HALF_DEG * half : foldLeafYaw(angle);
  return {
    angle,
    leftYaw: angle < 90 ? 180 - (180 - INNER_BOOK_HALF_DEG) * half : yaw,
    rightYaw: -yaw,
    offset: 1 - half,
  };
}
export function duoSliderPose(angle: number, display: DuoDisplay = duoDisplayForHingeAngle(angle)): DuoPose {
  if (display === "cover") {
    const pose = duoPose(angle);
    return { ...pose, leftYaw: 180 - angle / 2 };
  }
  if (angle >= 90) return duoPose(angle);
  const yaw = foldLeafYaw(angle);
  return { angle, leftYaw: yaw, rightYaw: -yaw, offset: 0 };
}
export function interpolateDuoPose(from: DuoPose, to: DuoPose, progress: number): DuoPose {
  if (progress <= 0) return from;
  if (progress >= 1) return to;
  const mix = (a: number, b: number) => a + (b - a) * progress;
  return { angle: mix(from.angle, to.angle), leftYaw: mix(from.leftYaw, to.leftYaw),
    rightYaw: mix(from.rightYaw, to.rightYaw), offset: mix(from.offset, to.offset) };
}
