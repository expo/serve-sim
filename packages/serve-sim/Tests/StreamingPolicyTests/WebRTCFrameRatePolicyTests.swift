import XCTest
@testable import StreamingPolicy

final class WebRTCFrameRatePolicyTests: XCTestCase {
    func testConfiguredFrameRateControlsOnlyThePublisherCadence() {
        for configuredFramesPerSecond in [30, 60, 140] {
            let policy = WebRTCFrameRatePolicy(
                configuredFramesPerSecond: configuredFramesPerSecond
            )

            XCTAssertEqual(policy.outputFramesPerSecond, configuredFramesPerSecond)
            XCTAssertEqual(policy.sourceAdapterFramesPerSecond, 1_000)
            XCTAssertNil(policy.senderFramesPerSecond)
        }
    }

    func testSimulatorCapturePollDefaultsToTwoHundredFortyHertz() {
        // Virtualized SimulatorKit delivers frame callbacks below display
        // cadence, so the poll is often the real detector. At 240 Hz a change
        // waits at most ~4 ms instead of ~17 ms.
        XCTAssertEqual(SimulatorCapturePollPolicy.pollsPerSecond(environmentValue: nil), 240)
        XCTAssertEqual(SimulatorCapturePollPolicy.intervalNanoseconds(pollsPerSecond: 240), 4_166_666)
        XCTAssertEqual(SimulatorCapturePollPolicy.intervalNanoseconds(pollsPerSecond: 60), 16_666_666)
    }

    func testSimulatorCapturePollOverrideIsParsedAndClamped() {
        XCTAssertEqual(SimulatorCapturePollPolicy.pollsPerSecond(environmentValue: "60"), 60)
        XCTAssertEqual(SimulatorCapturePollPolicy.pollsPerSecond(environmentValue: " 120\n"), 120)
        // Out of range values clamp rather than disable the poll.
        XCTAssertEqual(SimulatorCapturePollPolicy.pollsPerSecond(environmentValue: "10"), 30)
        XCTAssertEqual(SimulatorCapturePollPolicy.pollsPerSecond(environmentValue: "1000"), 480)
        // Garbage keeps the default.
        XCTAssertEqual(SimulatorCapturePollPolicy.pollsPerSecond(environmentValue: "fast"), 240)
        XCTAssertEqual(SimulatorCapturePollPolicy.pollsPerSecond(environmentValue: ""), 240)
    }

    func testClampsOnlyThePublisherCadenceToTheSupportedRange() {
        XCTAssertEqual(
            WebRTCFrameRatePolicy(configuredFramesPerSecond: 0).outputFramesPerSecond,
            1
        )
        XCTAssertEqual(
            WebRTCFrameRatePolicy(configuredFramesPerSecond: 240).outputFramesPerSecond,
            140
        )
    }
}
