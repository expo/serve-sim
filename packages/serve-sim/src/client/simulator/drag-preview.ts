/**
 * Local drag preview: the offset by which the viewer should translate the
 * video layer so dragged content follows the finger instantly, while the
 * remote frames catch up underneath.
 *
 * The remote frame on screen shows the simulator as of roughly one
 * drag-follow latency ago (input leg + injection + render + encode + return
 * leg). So the content "owed" to the eye is exactly the finger's travel over
 * that window: offset(t) = finger(t) − finger(t − latency). Implemented over
 * a pruned sample trail, this needs no server feedback — as frames arrive,
 * old travel graduates out of the window and the preview drains by itself.
 * On release the leftover offset decays exponentially while the server
 * renders the fling.
 *
 * Pure math over caller-supplied timestamps, so it is unit-testable; the
 * component drives it from pointer events and an animation-frame loop.
 */
export class DragPreviewTracker {
  private readonly latencyMs: number;
  private readonly releaseDecayMs: number;

  private samples: Array<{ t: number; x: number; y: number }> = [];
  private active = false;
  private release: { t: number; dx: number; dy: number } | null = null;

  constructor(options: { latencyMs: number; releaseDecayMs?: number }) {
    this.latencyMs = Math.max(0, options.latencyMs);
    this.releaseDecayMs = Math.max(1, options.releaseDecayMs ?? 120);
  }

  begin(t: number, x: number, y: number): void {
    this.active = true;
    this.release = null;
    this.samples = [{ t, x, y }];
  }

  move(t: number, x: number, y: number): void {
    if (!this.active) return;
    const last = this.samples[this.samples.length - 1];
    this.samples.push({ t: last ? Math.max(t, last.t) : t, x, y });
    this.prune(t);
  }

  end(t: number): void {
    if (!this.active) return;
    const offset = this.offsetAt(t);
    this.active = false;
    this.samples = [];
    this.release = offset.dx !== 0 || offset.dy !== 0
      ? { t, dx: offset.dx, dy: offset.dy }
      : null;
  }

  offsetAt(t: number): { dx: number; dy: number; settled: boolean } {
    if (this.active) {
      const current = this.samples[this.samples.length - 1];
      if (!current) return { dx: 0, dy: 0, settled: false };
      const past = this.positionAt(t - this.latencyMs);
      return { dx: current.x - past.x, dy: current.y - past.y, settled: false };
    }
    if (this.release) {
      const factor = Math.exp(-(t - this.release.t) / this.releaseDecayMs);
      const dx = this.release.dx * factor;
      const dy = this.release.dy * factor;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        this.release = null;
        return { dx: 0, dy: 0, settled: true };
      }
      return { dx, dy, settled: false };
    }
    return { dx: 0, dy: 0, settled: true };
  }

  /** Where the finger was at `t`, clamped to the trail's ends. */
  private positionAt(t: number): { x: number; y: number } {
    const first = this.samples[0]!;
    if (t <= first.t) return first;
    const last = this.samples[this.samples.length - 1]!;
    if (t >= last.t) return last;
    for (let i = 1; i < this.samples.length; i++) {
      const right = this.samples[i]!;
      if (right.t < t) continue;
      const left = this.samples[i - 1]!;
      const span = right.t - left.t;
      if (span <= 0) return right;
      const fraction = (t - left.t) / span;
      return {
        x: left.x + (right.x - left.x) * fraction,
        y: left.y + (right.y - left.y) * fraction,
      };
    }
    return last;
  }

  /** Keep one sample older than the window so interpolation stays bracketed. */
  private prune(now: number): void {
    const horizon = now - this.latencyMs;
    let firstNeeded = 0;
    while (
      firstNeeded + 1 < this.samples.length &&
      this.samples[firstNeeded + 1]!.t <= horizon
    ) {
      firstNeeded += 1;
    }
    if (firstNeeded > 0) this.samples.splice(0, firstNeeded);
  }
}
