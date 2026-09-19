import Testing

@testable import StreamingPolicy

@Suite("SimulatorScreenOrientation")
struct SimulatorScreenOrientationTests {
    @Test("reports the simulator screen's actual orientation, including Duo's landscape panel")
    func screenOrientations() {
        #expect(SimulatorScreenOrientation.name(for: 1) == "portrait")
        #expect(SimulatorScreenOrientation.name(for: 2) == "portrait_upside_down")
        #expect(SimulatorScreenOrientation.name(for: 3) == "landscape_left")
        #expect(SimulatorScreenOrientation.name(for: 4) == "landscape_right")
    }

    @Test("does not replace a known orientation with an ambiguous or future screen value")
    func unknownOrientation() {
        #expect(SimulatorScreenOrientation.name(for: 0) == nil)
        #expect(SimulatorScreenOrientation.name(for: UInt32.max) == nil)
    }

    @Test("maps authoritative CoreDevice display rotations and ignores unknown values")
    func coreDeviceRotation() {
        #expect(SimulatorScreenOrientation.name(forRotation: "rot0") == "portrait")
        #expect(SimulatorScreenOrientation.name(forRotation: "rot90") == "landscape_left")
        #expect(SimulatorScreenOrientation.name(forRotation: "rot180") == "portrait_upside_down")
        #expect(SimulatorScreenOrientation.name(forRotation: "rot270") == "landscape_right")
        #expect(SimulatorScreenOrientation.name(forRotation: "unknown") == nil)
    }
}
