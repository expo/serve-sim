import Testing

@testable import StreamingPolicy

@Suite("HIDTargetPolicy")
struct HIDTargetPolicyTests {
    @Test("Universal HID delivers inner input and releases on its original panel")
    func universalInnerGesture() {
        var policy = HIDTargetPolicy()
        policy.setScreen(3, universalHID: true)
        #expect(policy.target(for: "begin") == 0x103)
        policy.setScreen(1, universalHID: true)
        #expect(policy.target(for: "move") == 0x103)
        #expect(policy.target(for: "end") == 0x103)
        #expect(policy.target(for: "begin") == 0x101)
        #expect(policy.target(for: "end") == 0x101)
    }

    @Test("a cover touch releases on the cover when the inner screen becomes active")
    func coverGestureRelease() {
        var policy = HIDTargetPolicy()
        policy.setScreen(1, universalHID: true)
        #expect(policy.target(for: "begin") == 0x101)
        policy.setScreen(3, universalHID: true)
        #expect(policy.target(for: "move") == 0x101)
        #expect(policy.target(for: "end") == 0x101)
        #expect(policy.target(for: "begin") == 0x103)
        #expect(policy.target(for: "end") == 0x103)
    }

    @Test("Universal HID waits for a known panel without redirecting an in-flight gesture")
    func unknownUniversalScreen() {
        var policy = HIDTargetPolicy()
        policy.setScreen(nil, universalHID: true)
        #expect(policy.target(for: "begin") == nil)
        policy.setScreen(3, universalHID: true)
        #expect(policy.target(for: "move") == nil)
        #expect(policy.target(for: "end") == nil)
        #expect(policy.target(for: "begin") == 0x103)
    }

    @Test("uses the legacy digitizer until capture identifies a screen")
    func legacyTarget() {
        var policy = HIDTargetPolicy()
        #expect(policy.target(for: "begin") == 0x32)
        #expect(policy.target(for: "end") == 0x32)
    }

    @Test("routes an explicit touch to its selected internal display")
    func selectedScreen() {
        var policy = HIDTargetPolicy()
        policy.setScreen(3)
        #expect(policy.target(for: "begin") == 0x4000_0003)
        #expect(policy.target(for: "end") == 0x4000_0003)
    }

    @Test("finishes a gesture on its original display before switching")
    func pinsGesture() {
        var policy = HIDTargetPolicy()
        policy.setScreen(3)
        #expect(policy.target(for: "begin") == 0x4000_0003)
        policy.setScreen(1)
        #expect(policy.target(for: "move") == 0x4000_0003)
        #expect(policy.target(for: "end") == 0x4000_0003)
        #expect(policy.target(for: "begin") == 0x4000_0001)
        #expect(policy.target(for: "end") == 0x4000_0001)
    }

    @Test("rejects unsupported phases without changing the gesture")
    func ignoresUnsupportedPhase() {
        var policy = HIDTargetPolicy()
        policy.setScreen(3)
        #expect(policy.target(for: "begin") == 0x4000_0003)
        policy.setScreen(1)
        #expect(policy.target(for: "invalid") == nil)
        #expect(policy.target(for: "end") == 0x4000_0003)
    }

    @Test("a missing display ID falls back without redirecting an active gesture")
    func resetsSelection() {
        var policy = HIDTargetPolicy()
        policy.setScreen(3)
        #expect(policy.target(for: "begin") == 0x4000_0003)
        policy.setScreen(nil)
        #expect(policy.target(for: "end") == 0x4000_0003)
        #expect(policy.target(for: "begin") == 0x32)
    }
}
