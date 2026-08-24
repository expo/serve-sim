import XCTest
@testable import StreamingPolicy

final class ContinuousFramePacerTests: XCTestCase {
    func testRepeatsTheLatestFrameAtTheConfiguredCadence() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)

        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 1_000), 0)
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 1_000),
            .send(nextDelayNanoseconds: 16_666_666)
        )

        // No new frame arrived, but an active WebRTC stream keeps the same
        // configured cadence by repeating the retained latest frame.
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 16_667_666),
            .send(nextDelayNanoseconds: 16_666_666)
        )
    }

    func testUsesTheConfiguredFrameRateInsteadOfAHardcodedIdleRate() {
        var pacer = ContinuousFramePacer(framesPerSecond: 24)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), 0)
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 0),
            .send(nextDelayNanoseconds: 41_666_666)
        )

        pacer.update(framesPerSecond: 60)
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 16_666_666),
            .send(nextDelayNanoseconds: 16_666_666)
        )
    }

    func testLateTicksKeepTheOriginalCadenceInsteadOfAccumulatingTimerDrift() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), 0)
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 0),
            .send(nextDelayNanoseconds: 16_666_666)
        )

        // Dispatch woke about 3.3 ms late. The following delay is shortened
        // by the same amount so that lateness does not permanently reduce a
        // configured 60 fps cadence to roughly 50 fps.
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 20_000_000),
            .send(nextDelayNanoseconds: 13_333_332)
        )
    }

    func testNewFramesReplaceTheRetainedFrameWithoutStartingAnotherPump() {
        var pacer = ContinuousFramePacer(framesPerSecond: 30)
        pacer.setActive(true)

        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), 0)
        XCTAssertNil(pacer.latestFrameArrived(atNanoseconds: 5_000_000))
    }

    func testStopsCadenceAndDropsFrameStateWhenInactive() {
        var pacer = ContinuousFramePacer(framesPerSecond: 30)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), 0)

        pacer.setActive(false)
        XCTAssertEqual(pacer.tick(atNanoseconds: 33_333_333), .stop)

        pacer.setActive(true)
        XCTAssertEqual(pacer.tick(atNanoseconds: 66_666_666), .stop)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 70_000_000), 0)
    }
}
