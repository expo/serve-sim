public struct WebRTCFrameRatePolicy: Equatable, Sendable {
    /// Production experiment: run every WebRTC frame-rate control at the same
    /// deliberately high ceiling. The configured value is ignored so we can
    /// determine whether lower, independently phased caps are suppressing the
    /// real encoder cadence.
    public static let experimentalFramesPerSecond = 120

    public let outputFramesPerSecond: Int

    public init(configuredFramesPerSecond _: Int) {
        outputFramesPerSecond = Self.experimentalFramesPerSecond
    }

    public var captureFramesPerSecond: Int {
        Self.experimentalFramesPerSecond
    }

    public var sourceAdapterFramesPerSecond: Int {
        Self.experimentalFramesPerSecond
    }
}
