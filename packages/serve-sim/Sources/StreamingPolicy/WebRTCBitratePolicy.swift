public struct WebRTCBitratePolicy: Equatable, Sendable {
    /// Below this the stream is not worth keeping alive at any resolution.
    public static let absoluteMinimumBitsPerSecond = 250_000

    public let minimumBitsPerSecond: Int
    public let maximumBitsPerSecond: Int

    /// The estimator starts at the target (the owner passes the maximum as the
    /// starting estimate), so ramp-up stays instant on healthy paths. The
    /// minimum only bounds how far congestion control may back off: at 10% of
    /// target it can shrink into what a constrained path actually carries.
    /// The previous minimum was 90% of target, which pinned the estimator into
    /// a band the path sometimes could not carry — sustained overshoot, loss,
    /// recovery keyframes, and freezes instead of a quality dip.
    public init(targetBitsPerSecond: Int) {
        minimumBitsPerSecond = min(
            targetBitsPerSecond,
            max(Self.absoluteMinimumBitsPerSecond, targetBitsPerSecond / 10)
        )
        maximumBitsPerSecond = targetBitsPerSecond
    }
}
