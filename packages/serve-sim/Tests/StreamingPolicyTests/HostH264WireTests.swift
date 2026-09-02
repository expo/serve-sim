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
