public struct ContinuousFramePacer: Sendable {
    public enum TickDecision: Equatable, Sendable {
        case stop
        case wait(nanoseconds: UInt64)
        case send(timestampNanoseconds: UInt64, nextDelayNanoseconds: UInt64)
    }

    public enum ArrivalDecision: Equatable, Sendable {
        /// Frames received while the stream is inactive are intentionally ignored.
        case ignore
        /// Retain the new frame, but let a later arrival or the repeat timer send it.
        case hold
        /// Send the fresh frame now. Only the first frame starts the repeat-timer chain.
        case send(timestampNanoseconds: UInt64, firstRepeatDelayNanoseconds: UInt64?)
    }

    /// Capture at display cadence has a few milliseconds of normal jitter. This tolerance only
    /// compares fresh captures with earlier fresh captures; a late duplicate must never block
    /// motion from being delivered.
    private var freshFrameToleranceNanoseconds: UInt64 {
        min(frameIntervalNanoseconds / 4, 5_000_000)
    }

    /// Give a normal capture callback time to arrive before repeating the retained frame. During
    /// motion this keeps the timer out of the way; once motion stops, repeats resume at the exact
    /// configured cadence and keep the encoder warm.
    private var firstRepeatGraceNanoseconds: UInt64 {
        freshFrameToleranceNanoseconds
    }

    private var frameIntervalNanoseconds: UInt64
    private var active = false
    private var hasFrame = false
    private var hasPendingFreshFrame = false
    private var repeatTickScheduled = false
    private var lastFreshFrameSentAtNanoseconds: UInt64?
    private var lastSentAtNanoseconds: UInt64?
    private var nextRepeatAtNanoseconds: UInt64?

    public init(framesPerSecond: Int) {
        frameIntervalNanoseconds = Self.interval(framesPerSecond: framesPerSecond)
    }

    public mutating func update(framesPerSecond: Int) {
        frameIntervalNanoseconds = Self.interval(framesPerSecond: framesPerSecond)
        if let lastSentAtNanoseconds {
            nextRepeatAtNanoseconds = lastSentAtNanoseconds &+ frameIntervalNanoseconds
        }
    }

    public mutating func setActive(_ active: Bool) {
        guard self.active != active else { return }
        self.active = active
        if !active {
            hasFrame = false
            hasPendingFreshFrame = false
            repeatTickScheduled = false
            lastFreshFrameSentAtNanoseconds = nil
            lastSentAtNanoseconds = nil
            nextRepeatAtNanoseconds = nil
        }
    }

    /// Offers the newest captured frame. Fresh captures are paced relative only to the previous
    /// fresh capture—not to timer-driven repeats—so a late VM timer cannot suppress animation.
    public mutating func latestFrameArrived(atNanoseconds now: UInt64) -> ArrivalDecision {
        guard active else { return .ignore }
        hasFrame = true

        if let lastFreshFrameSentAtNanoseconds {
            let nextFreshFrameAt = lastFreshFrameSentAtNanoseconds &+ frameIntervalNanoseconds
            if now &+ freshFrameToleranceNanoseconds < nextFreshFrameAt {
                hasPendingFreshFrame = true
                return .hold
            }
        }

        hasPendingFreshFrame = false
        lastFreshFrameSentAtNanoseconds = now
        lastSentAtNanoseconds = now
        let firstRepeatDelay = frameIntervalNanoseconds &+ firstRepeatGraceNanoseconds
        nextRepeatAtNanoseconds = now &+ firstRepeatDelay

        let shouldStartRepeatTimer = !repeatTickScheduled
        repeatTickScheduled = true
        return .send(
            timestampNanoseconds: now,
            firstRepeatDelayNanoseconds: shouldStartRepeatTimer ? firstRepeatDelay : nil
        )
    }

    /// Advances the static-frame repeat timer. A fresh capture can move the repeat deadline while
    /// an older timer is pending; that timer waits for the new deadline instead of creating a
    /// second cadence chain or emitting a duplicate beside the fresh frame.
    public mutating func tick(atNanoseconds now: UInt64) -> TickDecision {
        guard active, hasFrame, let nextRepeatAtNanoseconds else {
            repeatTickScheduled = false
            return .stop
        }
        if now < nextRepeatAtNanoseconds {
            return .wait(nanoseconds: nextRepeatAtNanoseconds &- now)
        }

        // Keep an absolute repeat cadence and skip slots missed during a longer stall instead of
        // bursting duplicates. Fresh captures reset this anchor independently.
        let elapsed = now &- nextRepeatAtNanoseconds
        let intervalsToAdvance = elapsed / frameIntervalNanoseconds &+ 1
        let nextRepeatAt = nextRepeatAtNanoseconds
            &+ (frameIntervalNanoseconds &* intervalsToAdvance)
        self.nextRepeatAtNanoseconds = nextRepeatAt
        if hasPendingFreshFrame {
            // The retained buffer changed since the preceding send, so this tick delivered fresh
            // content rather than a duplicate. Use its actual delivery time for fresh-frame
            // spacing; this avoids a back-to-back arrival immediately after the timer wake-up.
            hasPendingFreshFrame = false
            lastFreshFrameSentAtNanoseconds = now
        }
        lastSentAtNanoseconds = now
        return .send(
            timestampNanoseconds: now,
            nextDelayNanoseconds: nextRepeatAt &- now
        )
    }

    private static func interval(framesPerSecond: Int) -> UInt64 {
        1_000_000_000 / UInt64(max(1, framesPerSecond))
    }
}
