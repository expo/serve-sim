import XCTest
@testable import StreamingPolicy

final class WebRTCFrameRatePolicyTests: XCTestCase {
    func testConfiguredFrameRateOnlyControlsTheOutputPacer() {
        let policy = WebRTCFrameRatePolicy(configuredFramesPerSecond: 30)

        XCTAssertEqual(policy.outputFramesPerSecond, 30)
        XCTAssertEqual(policy.captureFramesPerSecond, 60)
        XCTAssertGreaterThan(
            policy.sourceAdapterFramesPerSecond,
            WebRTCFrameRatePolicy(configuredFramesPerSecond: 120).outputFramesPerSecond
        )
    }

    func testClampsOutputFrameRateToTheSupportedRange() {
        XCTAssertEqual(
            WebRTCFrameRatePolicy(configuredFramesPerSecond: 0).outputFramesPerSecond,
            1
        )
        XCTAssertEqual(
            WebRTCFrameRatePolicy(configuredFramesPerSecond: 240).outputFramesPerSecond,
            120
        )
    }
}
