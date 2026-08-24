public struct ContinuousFramePacer: Sendable {
    public enum TickDecision: Equatable, Sendable {
        case stop
        case wait(nanoseconds: UInt64)
        case send(timestampNanoseconds: UInt64, nextDelayNanoseconds: UInt64)
    }

    private static let schedulingToleranceNanoseconds: UInt64 = 1_000_000

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

    /// Records that the retained latest frame changed. Returns the delay for a
    /// first pump tick, or nil when an existing continuous pump already owns
    /// the cadence. Frames received while inactive are intentionally ignored.
    public mutating func latestFrameArrived(atNanoseconds now: UInt64) -> UInt64? {
        guard active else { return nil }
        hasFrame = true
        guard !tickScheduled else { return nil }
        tickScheduled = true
        guard let earliest = nextSendAtNanoseconds else { return 0 }
        return now &+ Self.schedulingToleranceNanoseconds >= earliest
            ? 0
            : earliest - now
    }

    /// Advances the pump. Once the first frame exists, every successful tick
    /// schedules another one, so static and changing content use the same
    /// configured cadence.
    public mutating func tick(atNanoseconds now: UInt64) -> TickDecision {
        guard active, hasFrame else {
            tickScheduled = false
            return .stop
        }
        if let earliest = nextSendAtNanoseconds {
            if now &+ Self.schedulingToleranceNanoseconds < earliest {
                return .wait(nanoseconds: earliest - now)
            }
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
