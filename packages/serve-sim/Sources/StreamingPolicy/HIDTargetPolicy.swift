/// Pins Indigo's digitizer target, including a blocked target, until lift.
public struct HIDTargetPolicy: Sendable {
    private var selectedTarget: UInt32? = 0x32
    private var gestureTarget: UInt32?
    private var gestureIsActive = false

    public init() {}

    public mutating func setScreen(_ screenID: UInt32?, primaryScreenOnly: Bool = false) {
        // Xcode 27.1 beta leaves the Duo's inner digitizer disconnected.
        // Explicit secondary input crashes backboardd; the default alias
        // delivers no input. Restrict that device to its working cover panel.
        if primaryScreenOnly && screenID != 1 {
            selectedTarget = nil
        } else {
            selectedTarget = screenID.map { 0x4000_0000 | $0 } ?? 0x32
        }
    }

    public mutating func target(for phase: String) -> UInt32? {
        switch phase {
        case "begin":
            gestureIsActive = true
            gestureTarget = selectedTarget
            return gestureTarget
        case "move":
            return gestureIsActive ? gestureTarget : selectedTarget
        case "end":
            let target = gestureIsActive ? gestureTarget : selectedTarget
            gestureIsActive = false
            gestureTarget = nil
            return target
        default:
            return nil
        }
    }
}
