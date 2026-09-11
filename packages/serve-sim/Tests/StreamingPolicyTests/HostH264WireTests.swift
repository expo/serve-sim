import XCTest
@testable import StreamingPolicy

final class HostH264PlanTests: XCTestCase {
    func testVirtualMacUsesHostUnlessFlaggedOff() {
        XCTAssertTrue(HostH264Plan.usesHostSocket(isVirtualMac: true, hostEncoderFlag: nil))
        XCTAssertFalse(HostH264Plan.usesHostSocket(isVirtualMac: true, hostEncoderFlag: "0"))
        XCTAssertFalse(HostH264Plan.usesHostSocket(isVirtualMac: true, hostEncoderFlag: "false"))
    }

    func testRealMacUsesInProcessUnlessFlaggedOn() {
        XCTAssertFalse(HostH264Plan.usesHostSocket(isVirtualMac: false, hostEncoderFlag: nil))
        XCTAssertTrue(HostH264Plan.usesHostSocket(isVirtualMac: false, hostEncoderFlag: "1"))
        XCTAssertTrue(HostH264Plan.usesHostSocket(isVirtualMac: false, hostEncoderFlag: "true"))
    }

    func testVirtualMacCapsEncodeLongEdgeEvenWithoutTheSidecar() {
        // Measured: at native 1206x2622 the H.264 session dropped after a few hundred
        // frames and the client ladder fell to software VP8. At 1280 it held past 3300.
        // The cap therefore has to apply to the guest hardware path, not just the sidecar.
        XCTAssertEqual(HostH264Plan.encodeMaxLongEdge(configuredMaxDimension: 0, isVirtualMac: true), 1280)
        XCTAssertEqual(HostH264Plan.encodeMaxLongEdge(configuredMaxDimension: 0, isVirtualMac: false), 0)
    }

    func testExplicitMaxDimensionAlwaysWins() {
        XCTAssertEqual(HostH264Plan.encodeMaxLongEdge(configuredMaxDimension: 720, isVirtualMac: true), 720)
        XCTAssertEqual(HostH264Plan.encodeMaxLongEdge(configuredMaxDimension: 2048, isVirtualMac: true), 2048)
    }

    func testSidecarDownFallsBackToGuestHardwareNotSoftwareVP8() {
        // The sidecar being absent says nothing about the guest's own encoder. Tart guests
        // reach the host AVE as `paravirtualized:...ave.avc`, so falling back must mean
        // guest hardware first. Returning `.disabled` here is what silently dropped Tart
        // streams to software VP8 at native resolution.
        XCTAssertEqual(
            HostH264Plan.encoderChoice(isVirtualMac: true, hostEncoderFlag: nil, hostSocketReachable: false),
            .guestVideoToolbox
        )
        XCTAssertEqual(
            HostH264Plan.encoderChoice(isVirtualMac: true, hostEncoderFlag: "1", hostSocketReachable: false),
            .guestVideoToolbox
        )
    }

    func testReachableSidecarStillWins() {
        XCTAssertEqual(
            HostH264Plan.encoderChoice(isVirtualMac: true, hostEncoderFlag: nil, hostSocketReachable: true),
            .hostSocket
        )
        XCTAssertEqual(
            HostH264Plan.encoderChoice(isVirtualMac: false, hostEncoderFlag: "1", hostSocketReachable: true),
            .hostSocket
        )
    }

    func testHostEncoderOffGoesStraightToGuestVideoToolbox() {
        // Reachability must not even be consulted when the sidecar is switched off.
        XCTAssertEqual(
            HostH264Plan.encoderChoice(isVirtualMac: true, hostEncoderFlag: "0", hostSocketReachable: true),
            .guestVideoToolbox
        )
        XCTAssertEqual(
            HostH264Plan.encoderChoice(isVirtualMac: false, hostEncoderFlag: nil, hostSocketReachable: false),
            .guestVideoToolbox
        )
    }

    func testVirtualMacStillProbesGuestVideoToolbox() {
        // Tart guests expose `paravirtualized:...ave.avc`, the host AVE reached through
        // the implicit VideoToolbox device (macOS 15.4+). Skipping the probe on
        // VirtualMac disabled a working hardware encoder and fell back to software VP8.
        XCTAssertTrue(HostH264Plan.probesGuestVideoToolbox(isVirtualMac: true))
        XCTAssertTrue(HostH264Plan.probesGuestVideoToolbox(isVirtualMac: false))
    }

    func testParavirtualizedEncoderCountsAsHardware() {
        XCTAssertEqual(
            HostH264Plan.isHardwareEncoderID("paravirtualized:com.apple.videotoolbox.videoencoder.ave.avc"),
            true
        )
        XCTAssertEqual(HostH264Plan.isHardwareEncoderID("com.apple.videotoolbox.videoencoder.ave.avc"), true)
        XCTAssertEqual(HostH264Plan.isHardwareEncoderID("com.apple.videotoolbox.videoencoder.h264"), false)
        XCTAssertNil(HostH264Plan.isHardwareEncoderID(nil))
    }

    func testHostAndPortDefaultsAndOverrides() {
        XCTAssertEqual(HostH264Plan.host(from: [:]), "192.168.64.1")
        XCTAssertEqual(HostH264Plan.port(from: [:]), 9876)
        XCTAssertEqual(HostH264Plan.host(from: ["SERVE_SIM_HOST_ENCODER_HOST": " 10.0.0.1 "]), "10.0.0.1")
        XCTAssertEqual(HostH264Plan.port(from: ["SERVE_SIM_HOST_ENCODER_PORT": "9001"]), 9001)
        XCTAssertEqual(HostH264Plan.port(from: ["SERVE_SIM_HOST_ENCODER_PORT": "0"]), 9876)
    }

    func testNv12SendSizeLeavesFullIPhoneSize() {
        let size = HostH264Plan.nv12SendSize(width: 1206, height: 2622)
        XCTAssertEqual(size?.width, 1206)
        XCTAssertEqual(size?.height, 2622)
    }

    func testNv12SendSizeCapsWhenAsked() {
        let size = HostH264Plan.nv12SendSize(width: 1206, height: 2622, maxLongEdge: 1280)
        XCTAssertEqual(size?.width, 588)
        XCTAssertEqual(size?.height, 1280)
    }

    func testNv12SendSizeLeaves720pAlone() {
        let size = HostH264Plan.nv12SendSize(width: 720, height: 1280)
        XCTAssertEqual(size?.width, 720)
        XCTAssertEqual(size?.height, 1280)
    }

    func testNv12SendSizeRejectsTinyFrames() {
        XCTAssertNil(HostH264Plan.nv12SendSize(width: 8, height: 8))
    }

    func testBitsPerSecondFromWebRTCKilobits() {
        XCTAssertEqual(HostH264Plan.bitsPerSecond(fromKilobits: 6_000), 6_000_000)
        XCTAssertEqual(HostH264Plan.bitsPerSecond(fromKilobits: 16_000), 16_000_000)
        XCTAssertEqual(HostH264Plan.bitsPerSecond(fromKilobits: 50), 100_000)
        XCTAssertEqual(HostH264Plan.bitsPerSecond(fromKilobits: 100_000), 50_000_000)
    }

    func testHostSocketTreatsNativeMaxDimensionAs1280() {
        XCTAssertEqual(
            HostH264Plan.sendMaxLongEdge(configuredMaxDimension: 0, usesHostSocket: /* host AVE */ true),
            1280
        )
        XCTAssertEqual(
            HostH264Plan.sendMaxLongEdge(configuredMaxDimension: 0, usesHostSocket: /* in-process VT */ false),
            0
        )
        XCTAssertEqual(
            HostH264Plan.sendMaxLongEdge(configuredMaxDimension: 720, usesHostSocket: /* host AVE */ true),
            720
        )
        XCTAssertEqual(
            HostH264Plan.sendMaxLongEdge(configuredMaxDimension: 1920, usesHostSocket: /* in-process VT */ false),
            1920
        )
    }

    func testNv12SendSizeAppliesHostSocketDefaultLongEdge() {
        let size = HostH264Plan.nv12SendSize(
            width: 1206,
            height: 2622,
            maxLongEdge: HostH264Plan.sendMaxLongEdge(
                configuredMaxDimension: 0,
                usesHostSocket: /* host AVE */ true
            )
        )
        XCTAssertEqual(size?.width, 588)
        XCTAssertEqual(size?.height, 1280)
    }
}

final class HostH264WireTests: XCTestCase {
    func testKeyframeSetsBit15WithoutChangingWidth() {
        let header = HostH264Wire.nv12Header(width: 1206, height: 2622, pts: 9, forceKeyframe: true)
        XCTAssertEqual(header.count, 12)
        let parsed = HostH264Wire.parseNV12Header(header)
        XCTAssertEqual(parsed?.width, 1206)
        XCTAssertEqual(parsed?.height, 2622)
        XCTAssertEqual(parsed?.pts, 9)
        XCTAssertEqual(parsed?.forceKeyframe, true)

        let delta = HostH264Wire.parseNV12Header(
            HostH264Wire.nv12Header(width: 1206, height: 2622, pts: 10, forceKeyframe: false)
        )
        XCTAssertEqual(delta?.forceKeyframe, false)
        XCTAssertEqual(delta?.width, 1206)
    }

    func testRateHeaderIsTwelveBytesAndRoundTrips() {
        let header = HostH264Wire.rateHeader(bitrate: 2_400_000)
        XCTAssertEqual(header.count, 12)
        XCTAssertEqual(HostH264Wire.parseRateHeader(header), 2_400_000)
        XCTAssertNil(HostH264Wire.parseRateHeader(HostH264Wire.nv12Header(width: 16, height: 16, pts: 0, forceKeyframe: false)))
    }

    func testAnnexBRewritesLengthPrefixedNals() {
        let nalu = Data([0x65, 0x88, 0x84, 0x00])
        var avcc = Data([0, 0, 0, UInt8(nalu.count)])
        avcc.append(nalu)
        let annex = HostH264Wire.annexB(fromAVCC: avcc)
        XCTAssertEqual(annex, Data([0, 0, 0, 1]) + nalu)
    }

    func testAnnexBStopsOnTruncatedLength() {
        XCTAssertTrue(HostH264Wire.annexB(fromAVCC: Data([0, 0, 0, 8, 0x65])).isEmpty)
    }
}
