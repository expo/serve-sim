public struct FramebufferSurfaceCandidate {
    public let screenID: UInt32?
    public let area: Int

    public init(screenID: UInt32?, area: Int) {
        self.screenID = screenID
        self.area = area
    }
}

/// Foldable simulators keep both IOSurfaces alive. Prefer the display reported
/// active by CoreDevice, retaining the legacy largest-surface fallback when
/// that information or its surface is unavailable.
public enum FramebufferSelectionPolicy {
    public static func preferredIndex(
        in candidates: [FramebufferSurfaceCandidate], activeScreenID: UInt32?
    ) -> Int? {
        let usable = candidates.indices.filter { candidates[$0].area > 0 }
        if let activeScreenID,
           let active = usable.filter({ candidates[$0].screenID == activeScreenID })
            .max(by: { candidates[$0].area < candidates[$1].area }) {
            return active
        }
        return usable.max(by: { candidates[$0].area < candidates[$1].area })
    }
}
