import type { SimulatorOrientation } from "../types";
import { ROTATE_LEFT_CYCLE } from "./orientation";

/** Follow requests until the latest pose is reported, then accept external rotation. */
export function createRotationCursor(initial: SimulatorOrientation = "portrait") {
  let orientation = initial;
  let pending: SimulatorOrientation | null = null;
  return {
    requestNext(): SimulatorOrientation {
      orientation = ROTATE_LEFT_CYCLE[orientation];
      pending = orientation;
      return orientation;
    },
    updateReadback(reported?: SimulatorOrientation | null): void {
      if (!reported || (pending !== null && reported !== pending)) return;
      orientation = reported;
      pending = null;
    },
  };
}
