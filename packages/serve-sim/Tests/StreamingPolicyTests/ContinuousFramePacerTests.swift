import XCTest
@testable import StreamingPolicy

final class ContinuousFramePacerTests: XCTestCase {
    func testDueCaptureArrivalCanWakeTheSixtyFpsSlotWithoutStartingAnotherCadence() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)

        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 0),
            .schedule(nanoseconds: 0)
        )
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 0),
            .send(timestampNanoseconds: 0, nextDelayNanoseconds: 16_666_666)
        )

        // A real 60 Hz capture commonly arrives just before the timer deadline.
        // It should wake this same slot immediately, not wait for another interval.
        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 13_000_000),
            .pumpNow
        )
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 13_000_000),
            .send(timestampNanoseconds: 13_000_000, nextDelayNanoseconds: 20_333_332)
        )
    }

    func testSustainedSlightlyEarlySixtyHzArrivalsDoNotCollapseToAlternateSlots() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        var nextChainedTick: UInt64?
        var latestFrameIndex = -1
        var submittedFrameIndexes: [Int] = []

        func runChainedTick(at nanoseconds: UInt64) {
            switch pacer.tick(atNanoseconds: nanoseconds) {
            case let .send(_, nextDelayNanoseconds):
                submittedFrameIndexes.append(latestFrameIndex)
                nextChainedTick = nanoseconds + nextDelayNanoseconds
            case let .wait(delayNanoseconds):
                nextChainedTick = nanoseconds + delayNanoseconds
            case .stop:
                nextChainedTick = nil
            }
        }

        for frameIndex in 0 ... 60 {
            // Model a capture callback that wakes 3.67 ms before each ideal
            // display slot. The old independently timed gates accepted only
            // every other callback and produced roughly 30-40 FPS.
            let arrivalNanoseconds = frameIndex == 0
                ? 0
                : UInt64(frameIndex) * 16_666_666 - 3_666_666

            while let tickNanoseconds = nextChainedTick,
                  tickNanoseconds < arrivalNanoseconds {
                runChainedTick(at: tickNanoseconds)
            }

            latestFrameIndex = frameIndex
            switch pacer.latestFrameArrived(atNanoseconds: arrivalNanoseconds) {
            case let .schedule(delayNanoseconds):
                nextChainedTick = arrivalNanoseconds + delayNanoseconds
            case .pumpNow:
                guard case .send = pacer.tick(atNanoseconds: arrivalNanoseconds) else {
                    return XCTFail("A due capture should claim its cadence slot")
                }
                submittedFrameIndexes.append(latestFrameIndex)
            case .ignore:
                XCTFail("Capture frame \(frameIndex) was skipped")
            }
        }

        XCTAssertEqual(submittedFrameIndexes, Array(0 ... 60))
    }

    func testRepeatsTheLatestFrameAtTheConfiguredCadence() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)

        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 1_000), .schedule(nanoseconds: 0))
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 1_000),
            .send(timestampNanoseconds: 1_000, nextDelayNanoseconds: 16_666_666)
        )
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 16_667_666),
            .send(timestampNanoseconds: 16_667_666, nextDelayNanoseconds: 16_666_666)
        )
    }

    func testLateTicksKeepTheAbsoluteCadenceInsteadOfAccumulatingDrift() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 0),
            .send(timestampNanoseconds: 0, nextDelayNanoseconds: 16_666_666)
        )

        XCTAssertEqual(
            pacer.tick(atNanoseconds: 20_000_000),
            .send(timestampNanoseconds: 20_000_000, nextDelayNanoseconds: 13_333_332)
        )
    }

    func testLateSendDoesNotAllowABackToBackArrivalSubmission() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))
        _ = pacer.tick(atNanoseconds: 0)
        _ = pacer.tick(atNanoseconds: 29_170_000)

        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 29_200_000),
            .ignore
        )

        // Tolerance is applied once. A late send must not make the next slot
        // eligible only half an interval later.
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 37_503_334),
            .wait(nanoseconds: 12_496_664)
        )
    }

    func testUpdatingFrameRateReanchorsFromThePreviousSubmission() {
        var pacer = ContinuousFramePacer(framesPerSecond: 24)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))
        _ = pacer.tick(atNanoseconds: 0)

        let replacementDelay = pacer.update(
            framesPerSecond: 60,
            atNanoseconds: 10_000_000
        )

        XCTAssertEqual(replacementDelay, 6_666_666)

        XCTAssertEqual(
            pacer.tick(atNanoseconds: 16_666_666),
            .send(timestampNanoseconds: 16_666_666, nextDelayNanoseconds: 16_666_666)
        )
    }

    func testUpdatingFrameRateBeforeTheFirstTickReplacesTheStarterTick() {
        var pacer = ContinuousFramePacer(framesPerSecond: 30)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))

        XCTAssertEqual(
            pacer.update(framesPerSecond: 120, atNanoseconds: 1),
            0
        )
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 1),
            .send(timestampNanoseconds: 1, nextDelayNanoseconds: 8_333_333)
        )
    }

    func testDeactivationClearsRetainedCadenceState() {
        var pacer = ContinuousFramePacer(framesPerSecond: 30)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))

        pacer.setActive(false)
        XCTAssertEqual(pacer.tick(atNanoseconds: 33_333_333), .stop)

        pacer.setActive(true)
        XCTAssertEqual(pacer.tick(atNanoseconds: 66_666_666), .stop)
        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 70_000_000),
            .schedule(nanoseconds: 0)
        )
    }
}
