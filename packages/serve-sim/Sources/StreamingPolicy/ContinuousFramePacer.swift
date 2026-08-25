public struct ContinuousFramePacer: Sendable {
    public enum ArrivalDecision: Equatable, Sendable {
        case ignore
        case pumpNow
        case schedule(nanoseconds: UInt64)
    }

    public enum TickDecision: Equatable, Sendable {
        case stop
        case wait(nanoseconds: UInt64)
        case send(timestampNanoseconds: UInt64, nextDelayNanoseconds: UInt64)
    }

    private var frameIntervalNanoseconds: UInt64
    private var active = false
    private var hasFrame = false
    private var tickScheduled = false
    private var lastSentAtNanoseconds: UInt64?
    private var nextSendAtNanoseconds: UInt64?

    private var schedulingToleranceNanoseconds: UInt64 {
        min(frameIntervalNanoseconds / 4, 5_000_000)
    }

    public init(framesPerSecond: Int) {
        frameIntervalNanoseconds = Self.interval(framesPerSecond: framesPerSecond)
    }

    /// Updates the sole configured output cadence. When `now` is supplied,
    /// the returned delay lets the owner replace its pending timer instead of
    /// waiting for a callback scheduled at the previous, slower rate.
    @discardableResult
    public mutating func update(
        framesPerSecond: Int,
        atNanoseconds now: UInt64? = nil
    ) -> UInt64? {
        frameIntervalNanoseconds = Self.interval(framesPerSecond: framesPerSecond)
        if let lastSentAtNanoseconds {
            nextSendAtNanoseconds = lastSentAtNanoseconds &+ frameIntervalNanoseconds
        }
        guard active, hasFrame, let now else {
            return nil
        }
        guard let nextSendAtNanoseconds else { return 0 }
        return nextSendAtNanoseconds > now ? nextSendAtNanoseconds - now : 0
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

    public mutating func latestFrameArrived(atNanoseconds now: UInt64) -> ArrivalDecision {
        guard active else { return .ignore }
        hasFrame = true
        guard nextSendAtNanoseconds != nil || lastSentAtNanoseconds != nil else {
            guard !tickScheduled else { return .ignore }
            tickScheduled = true
            return .schedule(nanoseconds: 0)
        }
        guard let earliest = earliestSendNanoseconds() else {
            return tickScheduled ? .pumpNow : .schedule(nanoseconds: 0)
        }
        guard now &+ schedulingToleranceNanoseconds < earliest else {
            return tickScheduled ? .pumpNow : .schedule(nanoseconds: 0)
        }
        guard !tickScheduled else { return .ignore }
        tickScheduled = true
        return .schedule(nanoseconds: earliest - now)
    }

    public mutating func tick(atNanoseconds now: UInt64) -> TickDecision {
        guard active, hasFrame else {
            tickScheduled = false
            return .stop
        }
        let toleratedNow = now &+ schedulingToleranceNanoseconds
        if let earliest = earliestSendNanoseconds(), toleratedNow < earliest {
            return .wait(nanoseconds: earliest - now)
        }

        let cadenceAnchor = nextSendAtNanoseconds ?? now
        // Treat a tick inside the tolerance window as consuming that cadence
        // slot. This skips an adjacent slot after a late wake-up instead of
        // emitting a catch-up burst only half an interval later.
        let elapsed = toleratedNow >= cadenceAnchor ? toleratedNow - cadenceAnchor : 0
        let intervalsToAdvance = elapsed / frameIntervalNanoseconds &+ 1
        let nextSendAt = cadenceAnchor &+ (frameIntervalNanoseconds &* intervalsToAdvance)
        lastSentAtNanoseconds = now
        nextSendAtNanoseconds = nextSendAt
        return .send(
            timestampNanoseconds: now,
            nextDelayNanoseconds: nextSendAt > now ? nextSendAt - now : 0
        )
    }

    private func earliestSendNanoseconds() -> UInt64? {
        var earliest = nextSendAtNanoseconds
        if let lastSentAtNanoseconds {
            let spacedSend = lastSentAtNanoseconds &+ frameIntervalNanoseconds
            earliest = max(earliest ?? spacedSend, spacedSend)
        }
        return earliest
    }

    private static func interval(framesPerSecond: Int) -> UInt64 {
        1_000_000_000 / UInt64(max(1, framesPerSecond))
    }
}
