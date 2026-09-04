import XCTest
@testable import StreamingPolicy

final class ContinuousFramePacerTests: XCTestCase {
    private let interval: UInt64 = 16_666_666

    func testTheFirstArrivalIsSentNowAndStartsTheRepeatChainOneIntervalLater() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)

        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 1_000),
            .sendAndSchedule(nanoseconds: interval)
        )
        // Nothing fresh arrived, so the chain repeats the retained frame.
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 1_000 + interval),
            .send(timestampNanoseconds: 1_000 + interval, nextDelayNanoseconds: interval)
        )
    }

    func testArrivalsAreNeverHeldForTheNextSlot() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .sendAndSchedule(nanoseconds: interval))

        // A capture landing 3 ms after the previous one still goes out
        // immediately; holding it for the grid was the 8 ms average latency the
        // old pump added.
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 3_000_000), .send)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 13_000_000), .send)
    }

    func testSustainedSixtyHzArrivalsAreAllSubmittedAndTheChainNeverRepeats() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        var nextChainedTick: UInt64?
        var submittedFrameIndexes: [Int] = []
        var repeats = 0

        for frameIndex in 0 ... 60 {
            // A capture callback that wakes 3.67 ms before each ideal display slot.
            let arrival = frameIndex == 0 ? 0 : UInt64(frameIndex) * interval - 3_666_666

            while let tick = nextChainedTick, tick < arrival {
                switch pacer.tick(atNanoseconds: tick) {
                case let .send(_, nextDelay):
                    repeats += 1
                    nextChainedTick = tick + nextDelay
                case let .wait(delay):
                    nextChainedTick = tick + delay
                case .stop:
                    nextChainedTick = nil
                }
            }

            switch pacer.latestFrameArrived(atNanoseconds: arrival) {
            case let .sendAndSchedule(delay):
                submittedFrameIndexes.append(frameIndex)
                nextChainedTick = arrival + delay
            case .send:
                submittedFrameIndexes.append(frameIndex)
            case .ignore:
                XCTFail("Capture frame \(frameIndex) was skipped")
            case .sendAndRestart:
                XCTFail("A live chain must not be reclaimed")
            }
        }

        XCTAssertEqual(submittedFrameIndexes, Array(0 ... 60))
        // Every slot had a fresh frame, so the chain only ever waited.
        XCTAssertEqual(repeats, 0)
    }

    func testRepeatsFillTheCadenceOnceArrivalsStop() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .sendAndSchedule(nanoseconds: interval))
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 10_000_000), .send)

        // The chain wakes on the old slot; the fresh frame moved the due slot.
        XCTAssertEqual(pacer.tick(atNanoseconds: interval), .wait(nanoseconds: 10_000_000))
        // From the last arrival on, repeats run one interval apart.
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 10_000_000 + interval),
            .send(timestampNanoseconds: 10_000_000 + interval, nextDelayNanoseconds: interval)
        )
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 10_000_000 + 2 * interval),
            .send(timestampNanoseconds: 10_000_000 + 2 * interval, nextDelayNanoseconds: interval)
        )
    }

    func testASlightlyEarlyTickStillRepeats() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .sendAndSchedule(nanoseconds: interval))

        // Timers can wake a hair early; within the tolerance the slot is taken
        // rather than deferred by another whole interval.
        XCTAssertEqual(
            pacer.tick(atNanoseconds: interval - 1_000_000),
            .send(timestampNanoseconds: interval - 1_000_000, nextDelayNanoseconds: interval + 1_000_000)
        )
    }

    func testLateTicksKeepTheAbsoluteCadenceInsteadOfAccumulatingDrift() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .sendAndSchedule(nanoseconds: interval))

        // Due at 16.67 ms, woke at 20 ms: the next slot stays on the grid.
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 20_000_000),
            .send(timestampNanoseconds: 20_000_000, nextDelayNanoseconds: 13_333_332)
        )
    }

    func testTicksArrivingConsistentlyLateHoldTheConfiguredRate() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .sendAndSchedule(nanoseconds: interval))

        // Every wake-up lands 14 ms late — routine for coalesced timers on a
        // virtualized host. The grid must keep repeating once per interval at
        // a constant phase offset instead of halving the rate.
        let lateness: UInt64 = 14_000_000
        var wake: UInt64 = interval + lateness
        var sends = 0
        var lastTimestamp: UInt64 = 0
        for _ in 0 ..< 61 {
            switch pacer.tick(atNanoseconds: wake) {
            case let .send(timestamp, nextDelay):
                sends += 1
                lastTimestamp = timestamp
                wake = wake + nextDelay + lateness
            case let .wait(delay):
                wake = wake + delay + lateness
            case .stop:
                return XCTFail("The pump must stay active")
            }
        }
        XCTAssertGreaterThanOrEqual(sends, 59)
        // 59+ repeats inside roughly one second proves the rate held.
        XCTAssertLessThanOrEqual(lastTimestamp, 1_050_000_000)
    }

    func testAStallLongerThanAnIntervalReanchorsWithoutASendBurst() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .sendAndSchedule(nanoseconds: interval))

        // An ~100 ms stall: one catch-up repeat fires immediately, re-anchored
        // to now, and the slot after it waits a full interval — a stall must
        // not drain a burst of queued slots into the encoder.
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 100_000_000),
            .send(timestampNanoseconds: 100_000_000, nextDelayNanoseconds: 0)
        )
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 100_000_100),
            .wait(nanoseconds: 16_666_566)
        )
    }

    func testALostPumpIsReclaimedByALaterArrival() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .sendAndSchedule(nanoseconds: interval))

        // The scheduled pump never fires again (a dropped or starved timer).
        // Arrivals keep going out immediately, which must not count as chain
        // liveness — production showed exactly this state: fresh frames
        // flowing, repeats absent, the encoder starving on an idle screen.
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 20_000_000), .send)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 40_000_000), .send)

        // Past the grace window the next arrival is still sent, and the owner
        // is told to start a replacement chain under a fresh generation.
        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 70_000_000),
            .sendAndRestart(nanoseconds: interval)
        )
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 70_000_000 + interval),
            .send(timestampNanoseconds: 70_000_000 + interval, nextDelayNanoseconds: interval)
        )
    }

    func testAHealthyChainIsNotReclaimed() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .sendAndSchedule(nanoseconds: interval))

        // Chained ticks keep proving liveness, so a late-but-alive chain is
        // never restarted from the arrival side.
        _ = pacer.tick(atNanoseconds: 33_400_000)
        _ = pacer.tick(atNanoseconds: 66_800_000)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 100_000_000), .send)
    }

    func testUpdatingFrameRateReanchorsFromThePreviousSubmission() {
        var pacer = ContinuousFramePacer(framesPerSecond: 24)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .sendAndSchedule(nanoseconds: 41_666_666))

        let replacementDelay = pacer.update(framesPerSecond: 60, atNanoseconds: 10_000_000)

        XCTAssertEqual(replacementDelay, 6_666_666)
        XCTAssertEqual(
            pacer.tick(atNanoseconds: interval),
            .send(timestampNanoseconds: interval, nextDelayNanoseconds: interval)
        )
    }

    func testUpdatingFrameRateWithoutAnActiveChainReturnsNothing() {
        var pacer = ContinuousFramePacer(framesPerSecond: 30)
        XCTAssertNil(pacer.update(framesPerSecond: 120, atNanoseconds: 1))
        pacer.setActive(true)
        XCTAssertNil(pacer.update(framesPerSecond: 120, atNanoseconds: 1))
    }

    func testDeactivationClearsRetainedCadenceState() {
        var pacer = ContinuousFramePacer(framesPerSecond: 30)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .sendAndSchedule(nanoseconds: 33_333_333))

        pacer.setActive(false)
        XCTAssertEqual(pacer.tick(atNanoseconds: 33_333_333), .stop)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 40_000_000), .ignore)

        pacer.setActive(true)
        XCTAssertEqual(pacer.tick(atNanoseconds: 66_666_666), .stop)
        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 70_000_000),
            .sendAndSchedule(nanoseconds: 33_333_333)
        )
    }
}
