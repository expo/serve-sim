import XCTest
@testable import StreamingPolicy

final class WebRTCFrameRatePolicyTests: XCTestCase {
    func testProductionSpikeHardcodesEveryWebRTCLimitTo120FPS() {
        let policy = WebRTCFrameRatePolicy(configuredFramesPerSecond: 30)

        XCTAssertEqual(policy.outputFramesPerSecond, 120)
        XCTAssertEqual(policy.captureFramesPerSecond, 120)
        XCTAssertEqual(policy.sourceAdapterFramesPerSecond, 120)
    }

    func testConfiguredFrameRateCannotChangeTheProductionSpike() {
        for configuredFramesPerSecond in [0, 1, 30, 60, 120, 240] {
            XCTAssertEqual(
                WebRTCFrameRatePolicy(
                    configuredFramesPerSecond: configuredFramesPerSecond
                ).outputFramesPerSecond,
                120
            )
        }
    }
}
