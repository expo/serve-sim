public struct ContinuousFramePacer: Sendable {
    public enum TickDecision: Equatable, Sendable {
        case stop
        case wait(nanoseconds: UInt64)
        case send(timestampNanoseconds: UInt64, nextDelayNanoseconds: UInt64)
    }

    /// A tick judged early is deferred to a timer that cannot hold a 60 Hz deadline, so this must
    /// stay above capture's jitter. Capped because that jitter comes from the 60 Hz display and does
    /// not grow with a lower configured rate.
    private var schedulingToleranceNanoseconds: UInt64 {
        min(frameIntervalNanoseconds / 4, 5_000_000)
    }

    private var frameIntervalNanoseconds: UInt64
    private var active = false
    private var hasFrame = false
    private var tickScheduled = false
    private var lastSentAtNanoseconds: UInt64?
    private var nextSendAtNanoseconds: UInt64?

    public init(framesPerSecond: Int) {
        frameIntervalNanoseconds = Self.interval(framesPerSecond: framesPerSecond)
    }

    public mutating func update(framesPerSecond: Int) {
        frameIntervalNanoseconds = Self.interval(framesPerSecond: framesPerSecond)
        if let lastSentAtNanoseconds {
            nextSendAtNanoseconds = lastSentAtNanoseconds &+ frameIntervalNanoseconds
        }
    }

    public mutating func setActive(_ active: Bool) {
        guard self.active != active else { return }
        self.active = active
        if !active {
            hasFrame = false
            tickScheduled = false
            lastSentAtNanoseconds = nil
            nextSendAtNanoseconds = nil
        }
    }

    public enum ArrivalDecision: Equatable, Sendable {
        /// Nothing to do: a scheduled tick already owns the cadence.
        case ignore
        /// Pump now without scheduling a follow-on; a tick is already pending.
        case pumpNow
        /// Start the cadence with a tick after this delay.
        case schedule(nanoseconds: UInt64)
    }

    private func earliestSend(after now: UInt64) -> UInt64? {
        var earliest = nextSendAtNanoseconds
        if let lastSent = lastSentAtNanoseconds {
            let spacing = lastSent &+ frameIntervalNanoseconds &- schedulingToleranceNanoseconds
            earliest = max(earliest ?? spacing, spacing)
        }
        guard let earliest, now &+ schedulingToleranceNanoseconds < earliest else { return nil }
        return earliest
    }

    /// Records that the retained latest frame changed. Frames received while inactive are
    /// intentionally ignored. Capture's wake-ups are more punctual than the pump's timer, so a frame
    /// that is already due is pumped from the arrival rather than left to the scheduled tick.
    public mutating func latestFrameArrived(atNanoseconds now: UInt64) -> ArrivalDecision {
        guard active else { return .ignore }
        hasFrame = true
        guard nextSendAtNanoseconds != nil || lastSentAtNanoseconds != nil else {
            // No cadence yet; the first tick will pick this frame up.
            guard !tickScheduled else { return .ignore }
            tickScheduled = true
            return .schedule(nanoseconds: 0)
        }
        guard let earliest = earliestSend(after: now) else {
            return tickScheduled ? .pumpNow : .schedule(nanoseconds: 0)
        }
        guard !tickScheduled else { return .ignore }
        tickScheduled = true
        return .schedule(nanoseconds: earliest &- now)
    }

    /// Advances the pump. Once the first frame exists, every successful tick
    /// schedules another one, so static and changing content use the same
    /// configured cadence.
    public mutating func tick(atNanoseconds now: UInt64) -> TickDecision {
        guard active, hasFrame else {
            tickScheduled = false
            return .stop
        }
        if let earliest = earliestSend(after: now) {
            return .wait(nanoseconds: earliest &- now)
        }

        // Keep an absolute cadence anchor. Scheduling the next tick relative
        // to `now` would permanently add dispatch/encoder latency to every
        // interval and turn a requested 60 fps into roughly 50 fps. Skip any
        // slots missed during a longer stall instead of emitting a burst.
        let cadenceAnchor = nextSendAtNanoseconds ?? now
        let elapsed = now >= cadenceAnchor ? now - cadenceAnchor : 0
        let intervalsToAdvance = elapsed / frameIntervalNanoseconds &+ 1
        let nextSendAt = cadenceAnchor &+ (frameIntervalNanoseconds &* intervalsToAdvance)
        lastSentAtNanoseconds = now
        nextSendAtNanoseconds = nextSendAt
        return .send(
            timestampNanoseconds: now,
            nextDelayNanoseconds: nextSendAt > now ? nextSendAt - now : 0
        )
    }

    private static func interval(framesPerSecond: Int) -> UInt64 {
        1_000_000_000 / UInt64(max(1, framesPerSecond))
    }
}
