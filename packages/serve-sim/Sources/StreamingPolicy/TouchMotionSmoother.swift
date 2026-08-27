/// Replays touch trajectories on a steady clock instead of injecting each
/// move the instant it arrives.
///
/// Over a long network path, moves arrive in bursts: several samples land in
/// one packet train, then nothing for tens of milliseconds. Injected raw, the
/// simulated finger teleports — the scrolled content jumps in steps that the
/// encoder then faithfully transmits, and UIKit derives fling velocity from
/// the corrupted timing, so momentum comes out wrong. The smoother buffers a
/// small delay of trajectory and re-injects interpolated positions at a fixed
/// tick rate, preserving the client's motion shape and release velocity.
///
/// Latency cost: drag-follow lags by the configured delay. Taps and
/// long-presses pass through unbuffered, so tap latency is unchanged.
///
/// Pure logic — the owner supplies every timestamp and drives the tick timer —
/// so the replay behavior is unit-testable like `ContinuousFramePacer`.
public struct TouchMotionSmoother: Sendable {
    public enum Phase: String, Equatable, Sendable {
        case begin
        case move
        case end
    }

    public struct Injection: Equatable, Sendable {
        public let phase: Phase
        public let x: Double
        public let y: Double

        public init(phase: Phase, x: Double, y: Double) {
            self.phase = phase
            self.x = x
            self.y = y
        }
    }

    public struct Result: Equatable, Sendable {
        /// Touches to inject now, in order.
        public let injections: [Injection]
        /// When to call `tick` next; nil when no tick is needed.
        public let nextTickDelayNanoseconds: UInt64?

        public static let none = Result(injections: [], nextTickDelayNanoseconds: nil)

        public init(injections: [Injection], nextTickDelayNanoseconds: UInt64?) {
            self.injections = injections
            self.nextTickDelayNanoseconds = nextTickDelayNanoseconds
        }
    }

    private struct Sample {
        let timeMs: Double
        let x: Double
        let y: Double
    }

    /// Replay may advance up to this factor faster than real time while the
    /// buffered lead exceeds twice the delay, so latency added by network
    /// stalls drains back out.
    private static let catchUpRate = 1.25
    /// A lead beyond this snaps replay forward once (a bounded jump) instead
    /// of replaying a long stale trajectory at fixed speed.
    private static let maxLeadMs = 300.0

    private let delayMs: Double
    private let tickIntervalMs: Double
    private let tickIntervalNs: UInt64
    private let delayNs: UInt64

    private var active = false
    private var ticking = false
    private var awaitingFirstTick = false
    private var anchorClientMs = 0.0
    private var anchorServerNs: UInt64 = 0
    private var replayMs = 0.0
    private var lastTickNs: UInt64 = 0
    private var leftSample = Sample(timeMs: 0, x: 0, y: 0)
    private var samples: [Sample] = []
    private var endSample: Sample?
    private var lastPosition = (x: 0.0, y: 0.0)

    public init(delayMilliseconds: Double = 50, ticksPerSecond: Int = 60) {
        delayMs = max(0, delayMilliseconds)
        tickIntervalMs = 1_000.0 / Double(max(1, ticksPerSecond))
        tickIntervalNs = UInt64(tickIntervalMs * 1_000_000)
        delayNs = UInt64(delayMs * 1_000_000)
    }

    /// Feed one arriving touch. `clientTimeMilliseconds` is the sender's own
    /// event time (any monotonic base); nil falls back to arrival time, which
    /// still de-bursts injection, just with the network's timing instead of
    /// the finger's.
    public mutating func touchArrived(
        phase: Phase,
        x: Double,
        y: Double,
        clientTimeMilliseconds: Double?,
        atNanoseconds now: UInt64
    ) -> Result {
        switch phase {
        case .begin:
            var injections: [Injection] = []
            if active {
                injections.append(Injection(phase: .end, x: lastPosition.x, y: lastPosition.y))
            }
            reset()
            active = true
            anchorServerNs = now
            anchorClientMs = clientTimeMilliseconds ?? 0
            replayMs = anchorClientMs
            leftSample = Sample(timeMs: anchorClientMs, x: x, y: y)
            lastPosition = (x, y)
            injections.append(Injection(phase: .begin, x: x, y: y))
            return Result(injections: injections, nextTickDelayNanoseconds: nil)

        case .move:
            guard active else {
                // A move with no gesture open (e.g. after a flush) keeps the
                // legacy pass-through behavior.
                lastPosition = (x, y)
                return Result(injections: [Injection(phase: .move, x: x, y: y)], nextTickDelayNanoseconds: nil)
            }
            samples.append(Sample(timeMs: clampedTime(clientTimeMilliseconds, atNanoseconds: now), x: x, y: y))
            guard !ticking else { return .none }
            ticking = true
            awaitingFirstTick = true
            lastTickNs = now
            return Result(injections: [], nextTickDelayNanoseconds: delayNs)

        case .end:
            guard active else {
                lastPosition = (x, y)
                return Result(injections: [Injection(phase: .end, x: x, y: y)], nextTickDelayNanoseconds: nil)
            }
            if samples.isEmpty && !ticking {
                // Tap or long-press: nothing buffered, keep the exact timing.
                reset()
                lastPosition = (x, y)
                return Result(injections: [Injection(phase: .end, x: x, y: y)], nextTickDelayNanoseconds: nil)
            }
            endSample = Sample(timeMs: clampedTime(clientTimeMilliseconds, atNanoseconds: now), x: x, y: y)
            guard !ticking else { return .none }
            ticking = true
            awaitingFirstTick = true
            lastTickNs = now
            return Result(injections: [], nextTickDelayNanoseconds: delayNs)
        }
    }

    /// Advance replay. Injects at most one move (or the final end) per tick.
    public mutating func tick(atNanoseconds now: UInt64) -> Result {
        guard active, ticking else { return .none }
        let elapsedMs = awaitingFirstTick
            ? tickIntervalMs
            : Double(now &- lastTickNs) / 1_000_000
        awaitingFirstTick = false
        lastTickNs = now

        let newestMs = endSample?.timeMs ?? samples.last?.timeMs ?? replayMs
        var availableMs = newestMs - replayMs
        if availableMs > Self.maxLeadMs {
            replayMs = newestMs - delayMs
            availableMs = newestMs - replayMs
        }
        guard availableMs > 0 else {
            if let endSample {
                let injection = Injection(phase: .end, x: endSample.x, y: endSample.y)
                reset()
                lastPosition = (injection.x, injection.y)
                return Result(injections: [injection], nextTickDelayNanoseconds: nil)
            }
            // Underrun: hold at the last position. The next arriving move
            // restarts replay after the delay, rebuilding the jitter lead.
            ticking = false
            return .none
        }

        let rate = availableMs > delayMs * 2 ? Self.catchUpRate : 1.0
        replayMs += min(elapsedMs * rate, availableMs)

        if let endSample, replayMs >= endSample.timeMs {
            let injection = Injection(phase: .end, x: endSample.x, y: endSample.y)
            reset()
            lastPosition = (injection.x, injection.y)
            return Result(injections: [injection], nextTickDelayNanoseconds: nil)
        }

        let position = interpolatedPosition(at: replayMs)
        lastPosition = position
        return Result(
            injections: [Injection(phase: .move, x: position.x, y: position.y)],
            nextTickDelayNanoseconds: tickIntervalNs
        )
    }

    /// Ends the active gesture immediately at its last replayed position —
    /// used when a bypassing event (multi-touch, edge gesture) must not
    /// interleave with buffered replay.
    public mutating func flushActiveGesture() -> Result {
        guard active else { return .none }
        let injection = Injection(phase: .end, x: lastPosition.x, y: lastPosition.y)
        reset()
        return Result(injections: [injection], nextTickDelayNanoseconds: nil)
    }

    private mutating func reset() {
        active = false
        ticking = false
        awaitingFirstTick = false
        samples.removeAll(keepingCapacity: true)
        endSample = nil
    }

    private func clampedTime(_ clientTimeMilliseconds: Double?, atNanoseconds now: UInt64) -> Double {
        let derived = clientTimeMilliseconds
            ?? anchorClientMs + Double(now &- anchorServerNs) / 1_000_000
        return max(derived, samples.last?.timeMs ?? leftSample.timeMs)
    }

    private mutating func interpolatedPosition(at timeMs: Double) -> (x: Double, y: Double) {
        while let first = samples.first, first.timeMs <= timeMs {
            leftSample = first
            samples.removeFirst()
        }
        guard let right = samples.first ?? endSample else {
            return (leftSample.x, leftSample.y)
        }
        let span = right.timeMs - leftSample.timeMs
        guard span > 0, timeMs > leftSample.timeMs else {
            return (leftSample.x, leftSample.y)
        }
        let fraction = min(1, (timeMs - leftSample.timeMs) / span)
        return (
            leftSample.x + (right.x - leftSample.x) * fraction,
            leftSample.y + (right.y - leftSample.y) * fraction
        )
    }
}
