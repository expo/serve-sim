import XCTest
@testable import StreamingPolicy

final class WebRTCFieldTrialPolicyTests: XCTestCase {
    func testConfiguresFastVP8DownscalingWithBalancedRecovery() {
        let policy = WebRTCFieldTrialPolicy(playoutDelayMaxMilliseconds: 42)

        XCTAssertEqual(
            policy.configuration,
            "WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:42/"
                + "WebRTC-Video-QualityScalerSettings/"
                + "sampling_period_ms:16,min_frames:10,initial_scale_factor:31.25/"
                + "WebRTC-Video-QualityScaling/"
                + "Enabled-29,85,149,205,24,37,26,36,0,0.999,1/"
                + "WebRTC-VideoRateControl/vp8_qp_max:63/"
        )
    }

    func testClampsPlayoutDelayToSupportedRange() {
        XCTAssertTrue(
            WebRTCFieldTrialPolicy(playoutDelayMaxMilliseconds: -1)
                .configuration
                .hasPrefix("WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:0/")
        )
        XCTAssertTrue(
            WebRTCFieldTrialPolicy(playoutDelayMaxMilliseconds: 1_001)
                .configuration
                .hasPrefix("WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:1000/")
        )
    }
}
