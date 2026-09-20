/// The size the framebuffer is snapshotted at, so the capture does not move the whole
/// screen through the GPU only to shrink it a step later.
public struct SnapshotSizePolicy: Equatable, Sendable {
    public let width: Int
    public let height: Int

    /// Encoders take even dimensions without an extra conversion pass. A zero or
    /// negative `maxDimension` means "don't shrink", still even-rounded: Duo's
    /// inner LCD is 2007×2853, and a 4:2:0 snapshot at those odd sizes panics Bun.
    public init(width: Int, height: Int, maxDimension: Int) {
        let longest = max(width, height)
        if maxDimension > 0, longest > maxDimension, width > 0, height > 0 {
            let scale = Double(maxDimension) / Double(longest)
            self.width = SnapshotSizePolicy.even(Double(width) * scale)
            self.height = SnapshotSizePolicy.even(Double(height) * scale)
            return
        }
        self.width = SnapshotSizePolicy.even(Double(width))
        self.height = SnapshotSizePolicy.even(Double(height))
    }

    private static func even(_ value: Double) -> Int {
        max(2, Int(value.rounded()) & ~1)
    }
}
