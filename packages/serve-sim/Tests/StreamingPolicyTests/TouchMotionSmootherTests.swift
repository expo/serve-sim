import XCTest
@testable import StreamingPolicy

private let ms: UInt64 = 1_000_000

final class TouchMotionSmootherTests: XCTestCase {
    func testTapsPassThroughWithoutBuffering() {
        var smoother = TouchMotionSmoother(delayMilliseconds: 50)

        let begin = smoother.touchArrived(
            phase: .begin, x: 0.5, y: 0.5, clientTimeMilliseconds: 1_000, atNanoseconds: 0
        )
        XCTAssertEqual(begin.injections, [.init(phase: .begin, x: 0.5, y: 0.5)])
        XCTAssertNil(begin.nextTickDelayNanoseconds)

        let end = smoother.touchArrived(
            phase: .end, x: 0.5, y: 0.5, clientTimeMilliseconds: 1_080, atNanoseconds: 80 * ms
        )
        XCTAssertEqual(end.injections, [.init(phase: .end, x: 0.5, y: 0.5)])
        XCTAssertNil(end.nextTickDelayNanoseconds)
    }

    func testABurstOfMovesReplaysAtTheTickCadenceInsteadOfTeleporting() {
        var smoother = TouchMotionSmoother(delayMilliseconds: 50)
        _ = smoother.touchArrived(phase: .begin, x: 0.0, y: 0.0, clientTimeMilliseconds: 0, atNanoseconds: 0)

        // Three moves spanning 48 ms of client time land in one network burst.
        let first = smoother.touchArrived(phase: .move, x: 0.1, y: 0.1, clientTimeMilliseconds: 16, atNanoseconds: 5 * ms)
        XCTAssertEqual(first.injections, [])
        XCTAssertEqual(first.nextTickDelayNanoseconds, 50 * ms)
        XCTAssertEqual(
            smoother.touchArrived(phase: .move, x: 0.2, y: 0.2, clientTimeMilliseconds: 32, atNanoseconds: 5 * ms),
            .none
        )
        XCTAssertEqual(
            smoother.touchArrived(phase: .move, x: 0.3, y: 0.3, clientTimeMilliseconds: 48, atNanoseconds: 5 * ms),
            .none
        )

        // Replay paces the burst out over several ticks; the first tick must not
        // jump to the newest position.
        var positions: [Double] = []
        var now: UInt64 = 55 * ms
        for _ in 0 ..< 3 {
            let result = smoother.tick(atNanoseconds: now)
            XCTAssertEqual(result.injections.count, 1)
            XCTAssertEqual(result.injections[0].phase, .move)
            positions.append(result.injections[0].x)
            now += 16_666_667
        }
        XCTAssertEqual(positions.count, 3)
        XCTAssertLessThan(positions[0], 0.15)
        XCTAssertGreaterThan(positions[2], positions[1])
        XCTAssertGreaterThan(positions[1], positions[0])
        // Even spacing: no step may cover most of the burst at once.
        XCTAssertLessThan(positions[0], positions[2] - positions[0])
    }

    func testAnUnderrunHoldsAndResumesWithoutTeleporting() {
        var smoother = TouchMotionSmoother(delayMilliseconds: 50)
        _ = smoother.touchArrived(phase: .begin, x: 0.0, y: 0.0, clientTimeMilliseconds: 0, atNanoseconds: 0)
        _ = smoother.touchArrived(phase: .move, x: 0.16, y: 0.0, clientTimeMilliseconds: 16, atNanoseconds: 16 * ms)

        // Drain everything that is buffered.
        var now: UInt64 = 66 * ms
        var lastX = 0.0
        var held: TouchMotionSmoother.Result = .none
        for _ in 0 ..< 4 {
            held = smoother.tick(atNanoseconds: now)
            if let injection = held.injections.first { lastX = injection.x }
            now += 16_666_667
            if held.nextTickDelayNanoseconds == nil { break }
        }
        // The buffer ran dry: the smoother holds instead of extrapolating.
        XCTAssertNil(held.nextTickDelayNanoseconds)
        XCTAssertLessThanOrEqual(lastX, 0.16)

        // A late burst restarts replay after the delay, continuing from where
        // the hold left off — not from the newest sample.
        let resume = smoother.touchArrived(phase: .move, x: 0.5, y: 0.0, clientTimeMilliseconds: 120, atNanoseconds: now)
        XCTAssertEqual(resume.injections, [])
        XCTAssertEqual(resume.nextTickDelayNanoseconds, 50 * ms)
        let firstResumed = smoother.tick(atNanoseconds: now + 50 * ms)
        XCTAssertEqual(firstResumed.injections.count, 1)
        XCTAssertLessThan(firstResumed.injections[0].x, 0.3)
    }

    func testEndDrainsTheTrajectoryBeforeFiring() {
        var smoother = TouchMotionSmoother(delayMilliseconds: 50)
        _ = smoother.touchArrived(phase: .begin, x: 0.0, y: 0.0, clientTimeMilliseconds: 0, atNanoseconds: 0)
        _ = smoother.touchArrived(phase: .move, x: 0.2, y: 0.0, clientTimeMilliseconds: 30, atNanoseconds: 5 * ms)
        let end = smoother.touchArrived(phase: .end, x: 0.4, y: 0.0, clientTimeMilliseconds: 60, atNanoseconds: 6 * ms)
        XCTAssertEqual(end.injections, [])

        var now: UInt64 = 55 * ms
        var sawEnd = false
        var moveCount = 0
        for _ in 0 ..< 8 {
            let result = smoother.tick(atNanoseconds: now)
            for injection in result.injections {
                if injection.phase == .end {
                    sawEnd = true
                    XCTAssertEqual(injection.x, 0.4)
                } else if injection.phase == .move {
                    moveCount += 1
                    XCTAssertFalse(sawEnd)
                }
            }
            now += 16_666_667
            if result.nextTickDelayNanoseconds == nil { break }
        }
        XCTAssertTrue(sawEnd)
        XCTAssertGreaterThanOrEqual(moveCount, 2)
    }

    func testANewBeginFlushesTheActiveGesture() {
        var smoother = TouchMotionSmoother(delayMilliseconds: 50)
        _ = smoother.touchArrived(phase: .begin, x: 0.0, y: 0.0, clientTimeMilliseconds: 0, atNanoseconds: 0)
        _ = smoother.touchArrived(phase: .move, x: 0.3, y: 0.3, clientTimeMilliseconds: 16, atNanoseconds: 5 * ms)
        _ = smoother.tick(atNanoseconds: 55 * ms)

        let next = smoother.touchArrived(
            phase: .begin, x: 0.9, y: 0.9, clientTimeMilliseconds: 500, atNanoseconds: 60 * ms
        )
        XCTAssertEqual(next.injections.count, 2)
        XCTAssertEqual(next.injections[0].phase, .end)
        XCTAssertEqual(next.injections[1], .init(phase: .begin, x: 0.9, y: 0.9))
    }

    func testMissingTimestampsFallBackToArrivalPacing() {
        var smoother = TouchMotionSmoother(delayMilliseconds: 50)
        _ = smoother.touchArrived(phase: .begin, x: 0.0, y: 0.0, clientTimeMilliseconds: nil, atNanoseconds: 0)
        _ = smoother.touchArrived(phase: .move, x: 0.1, y: 0.0, clientTimeMilliseconds: nil, atNanoseconds: 20 * ms)
        _ = smoother.touchArrived(phase: .move, x: 0.2, y: 0.0, clientTimeMilliseconds: nil, atNanoseconds: 25 * ms)
        _ = smoother.touchArrived(phase: .move, x: 0.3, y: 0.0, clientTimeMilliseconds: nil, atNanoseconds: 30 * ms)

        var now: UInt64 = 70 * ms
        var positions: [Double] = []
        for _ in 0 ..< 2 {
            let result = smoother.tick(atNanoseconds: now)
            if let injection = result.injections.first { positions.append(injection.x) }
            now += 16_666_667
        }
        XCTAssertEqual(positions.count, 2)
        XCTAssertGreaterThan(positions[1], positions[0])
    }

    func testRunawayLagSnapsOnceInsteadOfGrowingForever() {
        var smoother = TouchMotionSmoother(delayMilliseconds: 50)
        _ = smoother.touchArrived(phase: .begin, x: 0.0, y: 0.0, clientTimeMilliseconds: 0, atNanoseconds: 0)
        _ = smoother.touchArrived(phase: .move, x: 0.1, y: 0.0, clientTimeMilliseconds: 16, atNanoseconds: 5 * ms)
        // A giant late burst: 500 ms of client trajectory lands at once.
        _ = smoother.touchArrived(phase: .move, x: 0.9, y: 0.0, clientTimeMilliseconds: 516, atNanoseconds: 6 * ms)

        let result = smoother.tick(atNanoseconds: 56 * ms)
        // Replay snaps to within the configured window of the newest sample
        // rather than replaying half a second of stale motion.
        XCTAssertEqual(result.injections.count, 1)
        XCTAssertGreaterThan(result.injections[0].x, 0.5)
    }
}
