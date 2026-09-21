import { Euler, Quaternion, Vector3 } from "three";
import { HINGE_POSES, type HingePose } from "../../hinge-control";
import type { StreamConfig } from "../types";
import { duoPose } from "./duo-pose";

/** A view is captured on initialization or an explicit view command, never from hinge updates. */
export type DuoView = {
  rotation: [number, number, number, number];
  /** Laptop articulates around its stationary left/base panel. */
  fixedLeftFold?: number;
};

function captureView(physical: ReturnType<typeof duoPose>, pose?: HingePose | null): DuoView {
  return {
    rotation: new Quaternion().setFromEuler(new Euler(...physical.rotation, "YXZ")).toArray(),
    fixedLeftFold: pose === "laptop" ? physical.fold : undefined,
  };
}

export function duoInitialView(angle: number | undefined, pose: HingePose | null | undefined, config?: StreamConfig | null): DuoView {
  return captureView(duoPose(angle, pose, config?.screenId, config), pose);
}

/** Presets use their physical orientation, independent of delayed app/display metadata. */
export function duoPresetView(pose: HingePose): DuoView {
  const { angle } = HINGE_POSES.find(({ id }) => id === pose)!;
  return captureView(duoPose(angle, pose, undefined, undefined, 0), pose);
}

export function duoRotateView(view: DuoView, quarterTurns: number): DuoView {
  const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), quarterTurns * Math.PI / 2);
  return { ...view, rotation: turn.multiply(new Quaternion(...view.rotation)).toArray() };
}

export function duoViewFolds(fold: number, view: DuoView, anchorWeight = 1) {
  const offset = view.fixedLeftFold === undefined ? 0 : (view.fixedLeftFold - fold) * anchorWeight;
  return { left: fold + offset, right: -fold + offset };
}
