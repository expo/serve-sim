/// Routes internal-display touches to the screen being captured. A gesture must
/// lift on the display where it began, even if folding changes the active screen.
public struct HIDTargetPolicy: Sendable {
    private var selectedTarget: UInt32 = 0x32
    private var gestureTarget: UInt32?

    public init() {}

    public mutating func setScreen(_ screenID: UInt32?) {
        // SimulatorKit's SimDeviceHIDDigitizerHost uses this flag plus screenID
        // for internal displays. The legacy 0x32 target addresses the default
        // digitizer only, so it misses the Duo's unfolded display (screen 3).
        selectedTarget = screenID.map { 0x4000_0000 | $0 } ?? 0x32
    }

    public mutating func target(for phase: String) -> UInt32? {
        switch phase {
        case "begin":
            gestureTarget = selectedTarget
            return selectedTarget
        case "move":
            return gestureTarget ?? selectedTarget
        case "end":
            let target = gestureTarget ?? selectedTarget
            gestureTarget = nil
            return target
        default:
            return nil
        }
    }
}
