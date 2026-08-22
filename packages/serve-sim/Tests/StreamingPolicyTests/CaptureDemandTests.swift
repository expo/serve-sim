import XCTest
@testable import StreamingPolicy

final class CaptureDemandTests: XCTestCase {
    func testAggregatesTheFastestAndLargestActiveConsumer() {
        let controller = CaptureDemandController()
        let first = UUID()
        let second = UUID()
        controller.set(CaptureDemand(framesPerSecond: 15, maxDimension: 854), for: first)
        controller.set(CaptureDemand(framesPerSecond: 30, maxDimension: 1280), for: second)

        XCTAssertEqual(
            controller.snapshot()?.demand,
            CaptureDemand(framesPerSecond: 30, maxDimension: 1280)
        )
    }

    func testNativeResolutionDemandWinsOverScaledConsumers() {
        let controller = CaptureDemandController()
        controller.set(CaptureDemand(framesPerSecond: 30, maxDimension: 1024), for: UUID())
        controller.set(CaptureDemand(framesPerSecond: 5, maxDimension: 0), for: UUID())

        XCTAssertEqual(controller.snapshot()?.demand.maxDimension, 0)
    }

    func testReturnsNoDemandAfterLastConsumerLeaves() {
        let controller = CaptureDemandController()
        let id = UUID()
        controller.set(CaptureDemand(framesPerSecond: 30, maxDimension: 1280), for: id)
        controller.set(nil, for: id)

        XCTAssertNil(controller.snapshot())
    }
}
