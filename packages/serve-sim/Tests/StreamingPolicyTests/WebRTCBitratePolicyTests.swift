import XCTest
@testable import StreamingPolicy

final class WebRTCBitratePolicyTests: XCTestCase {
    func testLeavesCongestionControlRoomBelowTheConfiguredTarget() {
        let policy = WebRTCBitratePolicy(targetBitsPerSecond: 6_000_000)

        // 10% of target: under congestion the estimator may back off to a
        // survivable rate instead of overrunning a path that cannot carry
        // 90% of target — the old floor turned every real dip into loss,
        // recovery keyframes, and freezes.
        XCTAssertEqual(policy.minimumBitsPerSecond, 600_000)
        XCTAssertEqual(policy.maximumBitsPerSecond, 6_000_000)
    }

    func testMinimumNeverDropsBelowASurvivableAbsoluteFloor() {
        let policy = WebRTCBitratePolicy(targetBitsPerSecond: 1_000_000)

        // 10% would be 100 kbps — below what keeps the stream alive.
        XCTAssertEqual(policy.minimumBitsPerSecond, 250_000)
        XCTAssertEqual(policy.maximumBitsPerSecond, 1_000_000)
    }

    func testMinimumIsClampedToTinyConfiguredTargets() {
        let policy = WebRTCBitratePolicy(targetBitsPerSecond: 100_000)

        // The CLI accepts targets down to 100 kbps; the minimum must never
        // exceed the maximum.
        XCTAssertEqual(policy.minimumBitsPerSecond, 100_000)
        XCTAssertEqual(policy.maximumBitsPerSecond, 100_000)
    }
}
