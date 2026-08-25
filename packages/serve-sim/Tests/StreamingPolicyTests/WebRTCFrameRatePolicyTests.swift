import XCTest
@testable import StreamingPolicy

final class WebRTCFrameRatePolicyTests: XCTestCase {
    func testConfiguredFrameRateControlsOnlyThePublisherCadence() {
        for configuredFramesPerSecond in [30, 60, 140] {
            let policy = WebRTCFrameRatePolicy(
                configuredFramesPerSecond: configuredFramesPerSecond
            )

            XCTAssertEqual(policy.outputFramesPerSecond, configuredFramesPerSecond)
            XCTAssertEqual(
                policy.captureFramesPerSecond,
                SimulatorCaptureFrameRatePolicy.maximumFramesPerSecond
            )
            XCTAssertEqual(policy.sourceAdapterFramesPerSecond, 1_000)
            XCTAssertNil(policy.senderFramesPerSecond)
        }
    }

    func testSimulatorCapturePollUsesTheFixedDisplayCadence() {
        XCTAssertEqual(SimulatorCaptureFrameRatePolicy.maximumFramesPerSecond, 60)
        XCTAssertEqual(SimulatorCaptureFrameRatePolicy.pollIntervalNanoseconds, 16_666_667)
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
