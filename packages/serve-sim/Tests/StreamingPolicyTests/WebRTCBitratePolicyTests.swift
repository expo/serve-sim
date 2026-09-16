import XCTest
@testable import StreamingPolicy

final class WebRTCBitratePolicyTests: XCTestCase {
    func testLeavesTheEstimatorRoomToBackOff() {
        let policy = WebRTCBitratePolicy(targetBitsPerSecond: 6_000_000)

        XCTAssertEqual(policy.maximumBitsPerSecond, 6_000_000)
        XCTAssertEqual(policy.minimumBitsPerSecond, 600_000)
    }

    /// target/10 crosses the absolute floor at exactly 3 Mbps.
    func testCrossoverBetweenTheFractionAndTheAbsoluteFloor() {
        XCTAssertEqual(WebRTCBitratePolicy(targetBitsPerSecond: 2_999_990).minimumBitsPerSecond, 300_000)
        XCTAssertEqual(WebRTCBitratePolicy(targetBitsPerSecond: 3_000_000).minimumBitsPerSecond, 300_000)
        XCTAssertEqual(WebRTCBitratePolicy(targetBitsPerSecond: 3_000_010).minimumBitsPerSecond, 300_001)
    }

    func testKeepsAnAbsoluteFloorSoAStreamStaysWatchable() {
        // 10% of 1 Mbps would be 100 kbps, below anything worth looking at.
        let policy = WebRTCBitratePolicy(targetBitsPerSecond: 1_000_000)
        XCTAssertEqual(policy.minimumBitsPerSecond, 300_000)
    }

    func testNeverProposesAFloorAboveTheCeiling() {
        // An explicit request for a very small stream must stay honoured.
        let policy = WebRTCBitratePolicy(targetBitsPerSecond: 150_000)
        XCTAssertEqual(policy.maximumBitsPerSecond, 150_000)
        XCTAssertEqual(policy.minimumBitsPerSecond, 150_000)
        XCTAssertLessThanOrEqual(policy.minimumBitsPerSecond, policy.maximumBitsPerSecond)
    }

    func testHandlesDegenerateTargets() {
        let zero = WebRTCBitratePolicy(targetBitsPerSecond: 0)
        XCTAssertEqual(zero.minimumBitsPerSecond, 0)
        XCTAssertEqual(zero.maximumBitsPerSecond, 0)

        let negative = WebRTCBitratePolicy(targetBitsPerSecond: -1)
        XCTAssertEqual(negative.minimumBitsPerSecond, 0)
        XCTAssertEqual(negative.maximumBitsPerSecond, 0)
    }
}
