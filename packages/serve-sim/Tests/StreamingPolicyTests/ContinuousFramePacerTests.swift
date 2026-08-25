import XCTest
@testable import StreamingPolicy

final class ContinuousFramePacerTests: XCTestCase {
    func testFreshFrameSendsImmediatelyAndStartsTheRepeatChain() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)

        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 1_000),
            .send(
                timestampNanoseconds: 1_000,
                firstRepeatDelayNanoseconds: 20_833_332
            )
        )
    }

    func testStaticContentRepeatsAtConfiguredCadenceAfterArrivalGrace() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        _ = pacer.latestFrameArrived(atNanoseconds: 0)

        XCTAssertEqual(
            pacer.tick(atNanoseconds: 20_833_332),
            .send(timestampNanoseconds: 20_833_332, nextDelayNanoseconds: 16_666_666)
        )
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 37_499_998),
            .send(timestampNanoseconds: 37_499_998, nextDelayNanoseconds: 16_666_666)
        )
    }

    func testRepeatTimerWaitsForFreshFrameGraceInsteadOfRacingDisplayCapture() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        _ = pacer.latestFrameArrived(atNanoseconds: 0)

        XCTAssertEqual(
            pacer.tick(atNanoseconds: 16_666_666),
            .wait(nanoseconds: 4_166_666)
        )
    }

    func testUsesConfiguredFrameRateInsteadOfAHardcodedIdleRate() {
        var pacer = ContinuousFramePacer(framesPerSecond: 24)
        pacer.setActive(true)
        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 0),
            .send(
                timestampNanoseconds: 0,
                firstRepeatDelayNanoseconds: 46_666_666
            )
        )

        pacer.update(framesPerSecond: 60)
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 16_666_666),
            .send(timestampNanoseconds: 16_666_666, nextDelayNanoseconds: 16_666_666)
        )
    }

    func testLateRepeatTicksKeepAbsoluteCadenceInsteadOfAccumulatingDrift() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        _ = pacer.latestFrameArrived(atNanoseconds: 0)

        XCTAssertEqual(
            pacer.tick(atNanoseconds: 30_000_000),
            .send(timestampNanoseconds: 30_000_000, nextDelayNanoseconds: 7_499_998)
        )
    }

    func testFreshFramesUseArrivalTimeAsTheirMediaTimestamp() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)

        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 100_000_000),
            .send(
                timestampNanoseconds: 100_000_000,
                firstRepeatDelayNanoseconds: 20_833_332
            )
        )
        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 116_666_666),
            .send(
                timestampNanoseconds: 116_666_666,
                firstRepeatDelayNanoseconds: nil
            )
        )
    }

    func testFreshFramesRespectConfiguredRateRelativeToOtherFreshFrames() {
        var pacer = ContinuousFramePacer(framesPerSecond: 30)
        pacer.setActive(true)
        _ = pacer.latestFrameArrived(atNanoseconds: 0)

        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 5_000_000), .hold)
        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 33_333_333),
            .send(
                timestampNanoseconds: 33_333_333,
                firstRepeatDelayNanoseconds: nil
            )
        )
    }

    func testShared120HzCaptureStillRespectsAConfigured60FPSOutput() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        _ = pacer.latestFrameArrived(atNanoseconds: 0)

        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 8_333_333), .hold)
        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 16_666_666),
            .send(
                timestampNanoseconds: 16_666_666,
                firstRepeatDelayNanoseconds: nil
            )
        )
    }

    func testFreshFrameAfterALateRepeatIsNotBlockedByTheRepeatTimestamp() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        _ = pacer.latestFrameArrived(atNanoseconds: 0)

        XCTAssertEqual(
            pacer.tick(atNanoseconds: 30_000_000),
            .send(timestampNanoseconds: 30_000_000, nextDelayNanoseconds: 7_499_998)
        )
        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 33_333_333),
            .send(
                timestampNanoseconds: 33_333_333,
                firstRepeatDelayNanoseconds: nil
            )
        )

        // The already-pending repeat tick observes the arrival's new deadline instead of
        // duplicating the frame or starting another timer chain.
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 37_499_998),
            .wait(nanoseconds: 16_666_667)
        )
    }

    func testHeldFinalFrameIsEventuallyDeliveredByRepeatTimer() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        _ = pacer.latestFrameArrived(atNanoseconds: 0)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 5_000_000), .hold)

        XCTAssertEqual(
            pacer.tick(atNanoseconds: 20_833_332),
            .send(timestampNanoseconds: 20_833_332, nextDelayNanoseconds: 16_666_666)
        )
    }

    func testTimerDeliveryOfHeldFreshFramePreventsABackToBackFreshSend() {
        var pacer = ContinuousFramePacer(framesPerSecond: 24)
        pacer.setActive(true)
        _ = pacer.latestFrameArrived(atNanoseconds: 0)

        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 33_333_333), .hold)
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 46_666_666),
            .send(timestampNanoseconds: 46_666_666, nextDelayNanoseconds: 41_666_666)
        )
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 50_000_000), .hold)
    }

    func testStopsCadenceAndDropsFrameStateWhenInactive() {
        var pacer = ContinuousFramePacer(framesPerSecond: 30)
        pacer.setActive(true)
        _ = pacer.latestFrameArrived(atNanoseconds: 0)

        pacer.setActive(false)
        XCTAssertEqual(pacer.tick(atNanoseconds: 33_333_333), .stop)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 40_000_000), .ignore)

        pacer.setActive(true)
        XCTAssertEqual(pacer.tick(atNanoseconds: 66_666_666), .stop)
        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 70_000_000),
            .send(
                timestampNanoseconds: 70_000_000,
                firstRepeatDelayNanoseconds: 38_333_333
            )
        )
    }
}
