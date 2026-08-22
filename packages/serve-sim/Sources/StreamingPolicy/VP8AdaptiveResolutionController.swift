public struct VP8AdaptiveResolutionController: Sendable {
    private static let standardDimensions = [1280, 1024, 854]
    private static let downshiftSampleCount = 3
    private static let recoverySampleCount = 15

    public private(set) var currentMaxDimension: Int
    public private(set) var targetFramesPerSecond: Int

    private var dimensions: [Int]
    private var dimensionIndex = 0
    private var constrainedSampleCount = 0
    private var healthySampleCount = 0

    public init(configuredMaxDimension: Int, targetFramesPerSecond: Int) {
        let dimensions = Self.dimensions(configuredMaxDimension: configuredMaxDimension)
        self.dimensions = dimensions
        self.currentMaxDimension = dimensions[0]
        self.targetFramesPerSecond = max(1, targetFramesPerSecond)
    }

    public mutating func reset(configuredMaxDimension: Int, targetFramesPerSecond: Int) {
        dimensions = Self.dimensions(configuredMaxDimension: configuredMaxDimension)
        dimensionIndex = 0
        currentMaxDimension = dimensions[0]
        self.targetFramesPerSecond = max(1, targetFramesPerSecond)
        constrainedSampleCount = 0
        healthySampleCount = 0
    }

    /// Returns a new maximum dimension only when the ladder changes.
    public mutating func observe(
        submittedFramesPerSecond: Double,
        encodedFramesPerSecond: Double,
        qualityLimitationReason: String?
    ) -> Int? {
        let target = Double(targetFramesPerSecond)

        // A static simulator intentionally emits only the 5fps idle floor.
        // Never interpret that sparse input as encoder pressure.
        guard submittedFramesPerSecond >= target * 0.85 else {
            constrainedSampleCount = 0
            healthySampleCount = 0
            return nil
        }

        let reason = qualityLimitationReason?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let encoderIsConstrained = reason == "cpu" || encodedFramesPerSecond < target * 0.82

        if encoderIsConstrained {
            healthySampleCount = 0
            guard dimensionIndex + 1 < dimensions.count else {
                constrainedSampleCount = 0
                return nil
            }
            constrainedSampleCount += 1
            guard constrainedSampleCount >= Self.downshiftSampleCount else { return nil }
            constrainedSampleCount = 0
            dimensionIndex += 1
            currentMaxDimension = dimensions[dimensionIndex]
            return currentMaxDimension
        }

        constrainedSampleCount = 0
        let qualityIsHealthy = reason != "cpu" && reason != "bandwidth"
            && encodedFramesPerSecond >= target * 0.95
        guard qualityIsHealthy, dimensionIndex > 0 else {
            healthySampleCount = 0
            return nil
        }
        healthySampleCount += 1
        guard healthySampleCount >= Self.recoverySampleCount else { return nil }
        healthySampleCount = 0
        dimensionIndex -= 1
        currentMaxDimension = dimensions[dimensionIndex]
        return currentMaxDimension
    }

    private static func dimensions(configuredMaxDimension: Int) -> [Int] {
        // Software VP8 on virtualized macOS should not begin above 1280. An
        // explicit lower cap remains authoritative.
        let requested = configuredMaxDimension > 0
            ? min(configuredMaxDimension, standardDimensions[0])
            : standardDimensions[0]
        return [requested] + standardDimensions.dropFirst().filter { $0 < requested }
    }
}
