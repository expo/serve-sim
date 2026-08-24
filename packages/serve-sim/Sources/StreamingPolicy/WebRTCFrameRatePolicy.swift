public struct WebRTCFrameRatePolicy: Equatable, Sendable {
    /// Simulator displays render at 60 Hz. Capture changing surfaces at that
    /// cadence and let the latest-frame pacer own the configured output rate.
    public static let displayFramesPerSecond = 60

    /// `RTCVideoSource` requires an FPS when adapting dimensions. Keep its
    /// internal frame dropper well above every supported output setting so it
    /// cannot become a second, independently phased rate limiter.
    public static let unthrottledSourceAdapterFramesPerSecond = 1_000

    public let outputFramesPerSecond: Int

    public init(configuredFramesPerSecond: Int) {
        outputFramesPerSecond = max(1, min(120, configuredFramesPerSecond))
    }

    public var captureFramesPerSecond: Int {
        Self.displayFramesPerSecond
    }

    public var sourceAdapterFramesPerSecond: Int {
        Self.unthrottledSourceAdapterFramesPerSecond
    }
}
