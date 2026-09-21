import type { HingePose } from "../../hinge-control";
import type { SimulatorOrientation, StreamConfig } from "../types";
import { homeIndicatorEdge, rawEdgeForDisplayEdge, streamDisplayGeometry } from "../simulator/orientation";

export interface SpringValue { value: number; velocity: number }

/** Exact critically damped solution, independent of display refresh rate. */
export function stepDuoSpring(state: SpringValue, target: number, elapsed: number, frequency = 11): SpringValue {
  const dt = Math.max(0, Math.min(elapsed, 0.1));
  const offset = state.value - target;
  const impulse = state.velocity + frequency * offset;
  const decay = Math.exp(-frequency * dt);
  return {
    value: target + (offset + impulse * dt) * decay,
    velocity: (state.velocity - frequency * impulse * dt) * decay,
  };
}

/** Rotations are composed Y · X · Z so laptop/tent hinge axes stay horizontal. */
export function duoPoseRotation(angle: number, pose?: HingePose | null): [number, number, number] {
  if (pose === "laptop") return [-Math.PI / 4 + 0.20, -0.25, Math.PI / 2];
  if (pose === "tent") return [Math.PI / 2 + 0.12, Math.PI - 0.36, Math.PI / 2];
  const closed = Math.max(0, 1 - angle / 45);
  const cover = closed * closed * (3 - 2 * closed);
  return [0.10, -0.10 + cover * (Math.PI / 2 + 0.24), 0];
}

/** CoreSimulator's inner display uses a portrait native buffer, while the
 * unfolded Apple mesh is landscape. Its physical UVs require a clockwise
 * quarter-turn regardless of the app orientation. Cover UVs match the native
 * portrait buffer. Undo transport rotation only when cover pixels are wide. */
export function duoTextureRotation(cover: boolean, width: number, height: number, orientation?: SimulatorOrientation): number {
  if (!cover) return width < height ? Math.PI / 2 : 0;
  if (width <= height) return 0;
  return orientation === "landscape_right" ? Math.PI / 2 : -Math.PI / 2;
}

/** Screen UVs have their origin at the upper left, matching the GLB material. */
export function duoStreamPoint(x: number, y: number, textureRotation: number): { x: number; y: number } {
  if (textureRotation < 0) return { x: 1 - y, y: x };
  if (textureRotation > 0) return { x: y, y: 1 - x };
  return { x, y };
}

/** The home indicator follows the app display, not the folded mesh's UV edge. */
export function duoHomeIndicatorEdge(point: { x: number; y: number }, config: StreamConfig): number | undefined {
  const orientation = streamDisplayGeometry(config).inputOrientation;
  const displayY = orientation === "landscape_left" ? point.x
    : orientation === "landscape_right" ? 1 - point.x
    : orientation === "portrait_upside_down" ? 1 - point.y : point.y;
  const edge = homeIndicatorEdge(displayY);
  return edge === undefined ? undefined : rawEdgeForDisplayEdge(orientation, edge);
}

/** Display metadata can arrive before the decoder swaps its old IOSurface.
 * Compare shape rather than resolution, since transports scale and rotate it.
 * A small rounding allowance accepts one-pixel encoder dimension rounding. */
export function duoFrameMatchesConfig(width: number, height: number, config: Pick<StreamConfig, "width" | "height">): boolean {
  if (![width, height, config.width, config.height].every((value) => Number.isFinite(value) && value > 0)) return false;
  const sourceLong = Math.max(width, height);
  const configLong = Math.max(config.width, config.height);
  const sourceRatio = Math.min(width, height) / sourceLong;
  const configRatio = Math.min(config.width, config.height) / configLong;
  return Math.abs(sourceRatio - configRatio) <= 1.5 / Math.min(sourceLong, configLong);
}
