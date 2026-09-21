import { isHingeAngle, type HingeAngleResult } from "../../hinge-angle";

export type PendingHingeRequest = {
  angle: number;
  timer: ReturnType<typeof setTimeout>;
};

/** A null result leaves the current request pending. */
export function completeHingeRequest(request: PendingHingeRequest | null, result: HingeAngleResult) {
  // Only one request is in flight. Validation errors may omit the angle, so
  // every rejection belongs to that request; successful replies must match it.
  if (!request || (result.ok !== false && result.angle !== request.angle)) return null;
  clearTimeout(request.timer);
  return {
    error: result.ok ? null : result.error ?? "Simulator could not change the hinge angle.",
    angle: result.ok && isHingeAngle(result.angle) ? result.angle : undefined,
  };
}
