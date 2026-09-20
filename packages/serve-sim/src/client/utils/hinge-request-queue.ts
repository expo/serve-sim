import { isHingeAngle, type HingeAngleResult } from "../../hinge-angle";

/** Serial native commands with a single latest-wins waiting value. */
export class HingeRequestQueue {
  private pending: number | null = null;
  private latest: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private send: (angle: number) => boolean,
    private settled: (result: HingeAngleResult, idle: boolean) => void,
    private timeoutMs = 5000,
  ) {}

  get isPending() {
    return this.pending !== null;
  }

  request(angle: number) {
    if (!isHingeAngle(angle)) return;
    this.latest = angle;
    if (this.pending === null) this.flush();
  }

  acknowledge(result: HingeAngleResult) {
    if (result.angle !== this.pending) return;
    clearTimeout(this.timer);
    this.pending = null;
    if (!result.ok) this.latest = null;
    if (this.latest === result.angle) this.latest = null;
    this.settled(result, this.latest === null);
    if (this.latest !== null) this.flush();
  }

  cancel() {
    clearTimeout(this.timer);
    this.pending = this.latest = null;
  }

  private flush() {
    const angle = this.latest!;
    this.latest = null;
    this.pending = angle;
    this.timer = setTimeout(() => this.acknowledge({
      ok: false, angle,
      error: "The simulator did not confirm the hinge angle. Try selecting a fold position again.",
    }), this.timeoutMs);
    if (!this.send(angle)) this.acknowledge({
      ok: false, angle,
      error: "Connect to the simulator before changing its fold position.",
    });
  }
}
