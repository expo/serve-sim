public struct WebRTCBitratePolicy: Equatable, Sendable {
    public static let minimumTargetPercentage = 90
    public static let maximumTargetPercentage = 100

    public let minimumBitsPerSecond: Int
    public let maximumBitsPerSecond: Int

    public init(targetBitsPerSecond: Int) {
        minimumBitsPerSecond = targetBitsPerSecond * Self.minimumTargetPercentage
            / Self.maximumTargetPercentage
        maximumBitsPerSecond = targetBitsPerSecond
    }
}
