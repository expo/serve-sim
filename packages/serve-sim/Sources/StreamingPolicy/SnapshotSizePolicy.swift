/// The size the framebuffer is snapshotted at, so the capture does not move the whole
/// screen through the GPU only to shrink it a step later.
public struct SnapshotSizePolicy: Equatable, Sendable {
    public let width: Int
    public let height: Int

    /// Encoders take even dimensions without an extra conversion pass, and a zero or
    /// negative `maxDimension` means "leave it alone".
    public init(width: Int, height: Int, maxDimension: Int) {
        let longest = max(width, height)
        guard maxDimension > 0, longest > maxDimension, width > 0, height > 0 else {
            self.width = width
            self.height = height
            return
        }
        let scale = Double(maxDimension) / Double(longest)
        self.width = SnapshotSizePolicy.even(Double(width) * scale)
        self.height = SnapshotSizePolicy.even(Double(height) * scale)
    }

    private static func even(_ value: Double) -> Int {
        max(2, Int(value.rounded()) & ~1)
    }
}
