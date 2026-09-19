/// CoreSimulator's SimScreenUIOrientation values, shared by the framebuffer and
/// its properties-change callbacks. Zero means ambiguous, not portrait.
public enum SimulatorScreenOrientation {
    public static func name(for value: UInt32) -> String? {
        switch value {
        case 1: return "portrait"
        case 2: return "portrait_upside_down"
        case 3: return "landscape_left"
        case 4: return "landscape_right"
        default: return nil
        }
    }

    /// CoreDevice reports framebuffer rotation independently of the legacy
    /// SimScreen properties, which can remain stale after a hinge transition.
    public static func name(forRotation rotation: String) -> String? {
        switch rotation {
        case "rot0": return "portrait"
        case "rot90": return "landscape_left"
        case "rot180": return "portrait_upside_down"
        case "rot270": return "landscape_right"
        default: return nil
        }
    }
}
