import XCTest
@testable import StreamingPolicy

final class VP8AdaptiveResolutionControllerTests: XCTestCase {
    func testDownshiftsFrom1280To1024And854UnderSustainedPressure() {
        var controller = VP8AdaptiveResolutionController(
            configuredMaxDimension: 0,
            targetFramesPerSecond: 30
        )
        XCTAssertEqual(controller.currentMaxDimension, 1280)

        XCTAssertNil(observePressure(&controller, samples: 2))
        XCTAssertEqual(observePressure(&controller, samples: 1), 1024)
        XCTAssertEqual(observePressure(&controller, samples: 3), 854)
    }

    func testDoesNotDownshiftAnIdleSimulator() {
        var controller = VP8AdaptiveResolutionController(
            configuredMaxDimension: 1280,
            targetFramesPerSecond: 30
        )
        for _ in 0..<10 {
            XCTAssertNil(controller.observe(
                submittedFramesPerSecond: 5,
                encodedFramesPerSecond: 5,
                qualityLimitationReason: "cpu"
            ))
        }
        XCTAssertEqual(controller.currentMaxDimension, 1280)
    }

    func testRecoversOneStepOnlyAfterSustainedHealthyEncoding() {
        var controller = VP8AdaptiveResolutionController(
            configuredMaxDimension: 1280,
            targetFramesPerSecond: 30
        )
        XCTAssertEqual(observePressure(&controller, samples: 3), 1024)
        for _ in 0..<14 {
            XCTAssertNil(controller.observe(
                submittedFramesPerSecond: 30,
                encodedFramesPerSecond: 30,
                qualityLimitationReason: "none"
            ))
        }
        XCTAssertEqual(
            controller.observe(
                submittedFramesPerSecond: 30,
                encodedFramesPerSecond: 30,
                qualityLimitationReason: "none"
            ),
            1280
        )
    }

    func testRespectsAnExplicitCapBelowTheStandardLadder() {
        let controller = VP8AdaptiveResolutionController(
            configuredMaxDimension: 720,
            targetFramesPerSecond: 30
        )
        XCTAssertEqual(controller.currentMaxDimension, 720)
    }

    private func observePressure(
        _ controller: inout VP8AdaptiveResolutionController,
        samples: Int
    ) -> Int? {
        var change: Int?
        for _ in 0..<samples {
            change = controller.observe(
                submittedFramesPerSecond: 30,
                encodedFramesPerSecond: 20,
                qualityLimitationReason: "cpu"
            ) ?? change
        }
        return change
    }
}
