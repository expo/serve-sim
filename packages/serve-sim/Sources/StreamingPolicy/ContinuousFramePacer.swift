/// Paces one publisher's frame submissions to libwebrtc.
///
/// A fresh capture is submitted the moment it arrives. Holding it for the next
/// timer slot only adds latency — up to one interval, ~8 ms on average at
/// 60 Hz, and 10–15 ms at p50 tap-to-frame when measured end to end. The
/// chained timer stays as the *repeat* fallback: whenever no fresh frame has
/// gone out for a whole interval, it re-submits the retained frame so the
/// encoder, the bandwidth estimate and the receiver's jitter buffer keep a
/// steady cadence on an idle or slowly changing screen.
///
/// The owner runs the timer chain and reports two kinds of event here:
/// `latestFrameArrived` when capture delivers a new frame, and `tick` when a
/// chained timer fires. Every decision is returned rather than acted on, so
/// the policy is testable without a clock.
public struct ContinuousFramePacer: Sendable {
    public enum ArrivalDecision: Equatable, Sendable {
        /// Not active: drop the frame.
        case ignore
        /// Submit the fresh frame now. The repeat chain is already scheduled.
        case send
        /// Submit now, and arm the repeat chain after the given delay because
        /// no chain is scheduled yet.
        case sendAndSchedule(nanoseconds: UInt64)
        /// Submit now. The scheduled chain has not ticked for several
        /// intervals and is presumed lost: the owner must invalidate any
        /// zombie pump (bump its generation) and arm a fresh chain after the
        /// given delay.
        case sendAndRestart(nanoseconds: UInt64)
    }

    public enum TickDecision: Equatable, Sendable {
        case stop
        /// A frame went out recently. Re-arm to the moment a repeat is due.
        case wait(nanoseconds: UInt64)
        /// Repeat the retained frame with this timestamp, then re-arm.
        case send(timestampNanoseconds: UInt64, nextDelayNanoseconds: UInt64)
    }

    /// How many silent intervals a scheduled chain gets before an arrival may
    /// reclaim it as lost. Arrivals do not count as chain liveness — a dead
    /// chain with arrivals still flowing is exactly the state this guards
    /// against: fresh frames go out, repeats never do, and an idle screen
    /// starves the encoder.
    private static let lostPumpGraceIntervals: UInt64 = 4

    private var frameIntervalNanoseconds: UInt64
    private var active = false
    private var hasFrame = false
    private var tickScheduled = false
    /// Last submission of any kind (arrival or repeat).
    private var lastSentAtNanoseconds: UInt64?
    /// The grid slot the next repeat aims for. Re-anchored on every arrival
    /// and advanced by whole intervals on repeats, so a late wake costs phase,
    /// not rate.
    private var nextRepeatAtNanoseconds: UInt64?
    /// Last proof the scheduled chain exists: arming an initial or replacement
    /// pump, or any chained tick.
    private var chainSeenAtNanoseconds: UInt64?

    private var schedulingToleranceNanoseconds: UInt64 {
        min(frameIntervalNanoseconds / 4, 5_000_000)
    }

    public init(framesPerSecond: Int) {
        frameIntervalNanoseconds = Self.interval(framesPerSecond: framesPerSecond)
    }

    /// Updates the repeat cadence. When `now` is supplied, the returned delay
    /// lets the owner replace its pending timer instead of waiting for a
    /// callback scheduled at the previous rate.
    @discardableResult
    public mutating func update(
        framesPerSecond: Int,
        atNanoseconds now: UInt64? = nil
    ) -> UInt64? {
        frameIntervalNanoseconds = Self.interval(framesPerSecond: framesPerSecond)
        if let lastSentAtNanoseconds {
            nextRepeatAtNanoseconds = lastSentAtNanoseconds &+ frameIntervalNanoseconds
        }
        guard active, hasFrame, let now else {
            return nil
        }
        // The owner arms a replacement pump with the returned delay.
        chainSeenAtNanoseconds = now
        guard let nextRepeatAtNanoseconds else { return 0 }
        return nextRepeatAtNanoseconds > now ? nextRepeatAtNanoseconds - now : 0
    }

    public mutating func setActive(_ active: Bool) {
        guard self.active != active else { return }
        self.active = active
        if !active {
            hasFrame = false
            tickScheduled = false
            lastSentAtNanoseconds = nil
            nextRepeatAtNanoseconds = nil
            chainSeenAtNanoseconds = nil
        }
    }

    /// A fresh capture is available. It always goes out now; the decision only
    /// says what to do about the repeat chain.
    public mutating func latestFrameArrived(atNanoseconds now: UInt64) -> ArrivalDecision {
        guard active else { return .ignore }
        hasFrame = true
        lastSentAtNanoseconds = now
        // The next repeat is due one interval after this fresh frame.
        nextRepeatAtNanoseconds = now &+ frameIntervalNanoseconds
        if lostPump(atNanoseconds: now) {
            chainSeenAtNanoseconds = now
            return .sendAndRestart(nanoseconds: frameIntervalNanoseconds)
        }
        guard tickScheduled else {
            tickScheduled = true
            chainSeenAtNanoseconds = now
            return .sendAndSchedule(nanoseconds: frameIntervalNanoseconds)
        }
        return .send
    }

    /// A chained timer fired.
    public mutating func tick(atNanoseconds now: UInt64) -> TickDecision {
        guard active, hasFrame, let gridDue = nextRepeatAtNanoseconds else {
            tickScheduled = false
            chainSeenAtNanoseconds = nil
            return .stop
        }
        chainSeenAtNanoseconds = now
        // Two floors: the grid slot, and one interval after whatever went out
        // last (a fresh frame moves both). The spacing floor is what keeps a
        // re-anchored stall or a fresh arrival from being followed by a
        // back-to-back repeat.
        let spacedDue = (lastSentAtNanoseconds ?? 0) &+ frameIntervalNanoseconds
        let due = max(gridDue, spacedDue)
        if now &+ schedulingToleranceNanoseconds < due {
            return .wait(nanoseconds: due - now)
        }

        // Advance to the next grid slot, but never into the past: a late
        // wake-up must not skip cadence slots (consistently late timers on a
        // virtualized host would halve the rate), and a stall longer than an
        // interval re-anchors to `now` instead of draining a catch-up burst.
        let nextRepeatAt = max(gridDue &+ frameIntervalNanoseconds, now)
        lastSentAtNanoseconds = now
        nextRepeatAtNanoseconds = nextRepeatAt
        return .send(
            timestampNanoseconds: now,
            nextDelayNanoseconds: nextRepeatAt > now ? nextRepeatAt - now : 0
        )
    }

    /// True when a chain is supposedly scheduled but no chained tick has fired
    /// for the whole grace window.
    private func lostPump(atNanoseconds now: UInt64) -> Bool {
        guard tickScheduled, let chainSeenAtNanoseconds else { return false }
        let grace = frameIntervalNanoseconds &* Self.lostPumpGraceIntervals
        return now > chainSeenAtNanoseconds &+ grace
    }

    private static func interval(framesPerSecond: Int) -> UInt64 {
        1_000_000_000 / UInt64(max(1, framesPerSecond))
    }
}
