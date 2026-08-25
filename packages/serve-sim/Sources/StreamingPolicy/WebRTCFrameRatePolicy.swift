/// The simulator display is a fixed-rate physical source, independent from a
/// viewer's configured WebRTC output cadence. SimulatorKit callbacks provide
/// prompt changes; this poll interval fills callback gaps and seed checks
/// suppress unchanged copies.
public enum SimulatorCaptureFrameRatePolicy {
    public static let maximumFramesPerSecond = 60
    public static let pollIntervalNanoseconds: Int64 = 16_666_667
}

public struct WebRTCFrameRatePolicy: Equatable, Sendable {
    public static let displayFramesPerSecond =
        SimulatorCaptureFrameRatePolicy.maximumFramesPerSecond
    public static let maximumOutputFramesPerSecond = 140
    public static let unthrottledSourceAdapterFramesPerSecond = 1_000

    public let outputFramesPerSecond: Int

    public init(configuredFramesPerSecond: Int) {
        outputFramesPerSecond = max(
            1,
            min(Self.maximumOutputFramesPerSecond, configuredFramesPerSecond)
        )
    }

    public var captureFramesPerSecond: Int {
        Self.displayFramesPerSecond
    }

    public var sourceAdapterFramesPerSecond: Int {
        Self.unthrottledSourceAdapterFramesPerSecond
    }

    public var senderFramesPerSecond: Int? {
        nil
    }
}
