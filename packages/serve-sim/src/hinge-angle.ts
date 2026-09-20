export const HINGE_POSITIONS = [
  { label: "Fold", angle: 0 },
  { label: "Half Fold", angle: 90 },
  { label: "Unfold", angle: 180 },
] as const;
export const DUO_INNER_DISPLAY_MIN_ANGLE = 55;
export const DUO_OUTER_DISPLAY_MAX_ANGLE = 54;
export type DuoDisplay = "cover" | "inner";

export function duoDisplayForHingeAngle(angle: number, current: DuoDisplay = "cover"): DuoDisplay {
  if (angle >= DUO_INNER_DISPLAY_MIN_ANGLE) return "inner";
  if (angle <= DUO_OUTER_DISPLAY_MAX_ANGLE) return "cover";
  return current;
}

export function isHingeAngle(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 180;
}

export function parseHingeAngle(value: string): number | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "fold") return 0;
  if (normalized === "half") return 90;
  if (normalized === "unfold") return 180;
  if (!normalized) return undefined;
  const angle = Number(normalized);
  return isHingeAngle(angle) ? angle : undefined;
}

/**
 * The inner framebuffer is mounted at 270°. Rendering it clockwise keeps
 * the same physical portrait orientation as the cover.
 */
export function orientationForHingeAngle(
  angle: number,
  current: "portrait" | "landscape_left" = "portrait",
): "portrait" | "landscape_left" {
  return duoDisplayForHingeAngle(angle, current === "portrait" ? "cover" : "inner") === "cover"
    ? "portrait"
    : "landscape_left";
}

/**
 * How far each inner leaf yaws around the crease.
 * Closed is edge-on (90), Device Hub's half-fold is a book (35),
 * open is flat (0). Cover chrome is a separate rest pose below 55°.
 */
// Device Hub Book is ≈85% of the flat spread width, with outer/spine height
// ≈1.04. Together these constrain leaf yaw and perspective (7.5× spread width).
export const INNER_BOOK_HALF_DEG = 35;

export function foldLeafYaw(angle?: number): number {
  if (angle == null || !Number.isFinite(angle)) return 90;
  const clamped = Math.min(180, Math.max(0, angle));
  if (clamped <= 90) return 90 - (clamped / 90) * (90 - INNER_BOOK_HALF_DEG);
  return INNER_BOOK_HALF_DEG * (1 - (clamped - 90) / 90);
}

export type HingeAngleResult = {
  ok: boolean;
  angle?: number;
  error?: string;
};
