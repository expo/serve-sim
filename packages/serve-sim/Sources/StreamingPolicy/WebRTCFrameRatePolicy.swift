import Foundation

/// Cadence for supplemental IOSurface seed polling. SimulatorKit callbacks
/// still deliver prompt changes between polls, so this is not a capture-rate
/// ceiling.
///
/// On virtualized hosts the callbacks arrive below display cadence and the poll
/// is often the real change detector. A seed read is a shared-memory load, so
/// the poll runs well above the display rate: at 240 Hz a change waits at most
/// ~4 ms to be noticed instead of ~17 ms at 60 Hz. `SERVE_SIM_CAPTURE_POLL_HZ`
/// overrides the rate within [30, 480] for A/B runs.
public enum SimulatorCapturePollPolicy {
    public static let defaultPollsPerSecond = 240
    public static let minimumPollsPerSecond = 30
    public static let maximumPollsPerSecond = 480
    public static let environmentVariable = "SERVE_SIM_CAPTURE_POLL_HZ"

    /// Resolved once from the process environment.
    public static let pollsPerSecond: Int = pollsPerSecond(
        environmentValue: ProcessInfo.processInfo.environment[environmentVariable]
    )

    public static var intervalNanoseconds: Int64 {
        intervalNanoseconds(pollsPerSecond: pollsPerSecond)
    }

    /// An unparseable or missing override keeps the default; a parseable one is
    /// clamped to the supported range.
    public static func pollsPerSecond(environmentValue: String?) -> Int {
        guard
            let raw = environmentValue?.trimmingCharacters(in: .whitespacesAndNewlines),
            let parsed = Int(raw)
        else {
            return defaultPollsPerSecond
        }
        return min(maximumPollsPerSecond, max(minimumPollsPerSecond, parsed))
    }

    public static func intervalNanoseconds(pollsPerSecond: Int) -> Int64 {
        1_000_000_000 / Int64(max(1, pollsPerSecond))
    }
}

public struct WebRTCFrameRatePolicy: Equatable, Sendable {
    public static let maximumOutputFramesPerSecond = 140
    public static let unthrottledSourceAdapterFramesPerSecond = 1_000

    public let outputFramesPerSecond: Int

    public init(configuredFramesPerSecond: Int) {
        outputFramesPerSecond = max(
            1,
            min(Self.maximumOutputFramesPerSecond, configuredFramesPerSecond)
        )
    }

    public var sourceAdapterFramesPerSecond: Int {
        Self.unthrottledSourceAdapterFramesPerSecond
    }

    public var senderFramesPerSecond: Int? {
        nil
    }
}
