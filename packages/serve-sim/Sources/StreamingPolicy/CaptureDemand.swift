import Foundation

public struct CaptureDemand: Equatable, Sendable {
    public let framesPerSecond: Int
    public let maxDimension: Int

    public init(framesPerSecond: Int, maxDimension: Int) {
        self.framesPerSecond = max(1, framesPerSecond)
        self.maxDimension = max(0, maxDimension)
    }
}

public struct CaptureDemandSnapshot: Equatable, Sendable {
    public let demand: CaptureDemand
    public let revision: UInt64
}

/// Synchronous because the capture callback must decide whether retaining an
/// IOSurface frame is worthwhile before it performs any memory copy.
public final class CaptureDemandController: @unchecked Sendable {
    private let lock = NSLock()
    private var demands: [UUID: CaptureDemand] = [:]
    private var revision: UInt64 = 0

    public init() {}

    public func set(_ demand: CaptureDemand?, for id: UUID) {
        lock.lock()
        defer { lock.unlock() }
        if let demand {
            guard demands[id] != demand else { return }
            demands[id] = demand
        } else {
            guard demands.removeValue(forKey: id) != nil else { return }
        }
        revision &+= 1
    }

    public func snapshot() -> CaptureDemandSnapshot? {
        lock.lock()
        defer { lock.unlock() }
        guard !demands.isEmpty else { return nil }
        let framesPerSecond = demands.values.map(\.framesPerSecond).max() ?? 1
        let maxDimension = demands.values.contains(where: { $0.maxDimension == 0 })
            ? 0
            : demands.values.map(\.maxDimension).max() ?? 0
        return CaptureDemandSnapshot(
            demand: CaptureDemand(
                framesPerSecond: framesPerSecond,
                maxDimension: maxDimension
            ),
            revision: revision
        )
    }
}
