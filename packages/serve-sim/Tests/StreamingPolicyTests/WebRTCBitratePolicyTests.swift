import XCTest
@testable import StreamingPolicy

final class WebRTCBitratePolicyTests: XCTestCase {
    func testDefinesNinetyToHundredPercentTargetRange() {
        XCTAssertEqual(WebRTCBitratePolicy.minimumTargetPercentage, 90)
        XCTAssertEqual(WebRTCBitratePolicy.maximumTargetPercentage, 100)
    }

    func testKeepsAdaptiveBandwidthBetweenNinetyPercentAndConfiguredTarget() {
        let policy = WebRTCBitratePolicy(targetBitsPerSecond: 6_000_000)

        XCTAssertEqual(policy.minimumBitsPerSecond, 5_400_000)
        XCTAssertEqual(policy.maximumBitsPerSecond, 6_000_000)
    }
}
