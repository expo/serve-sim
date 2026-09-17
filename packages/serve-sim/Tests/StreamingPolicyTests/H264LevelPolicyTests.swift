import XCTest
@testable import StreamingPolicy

/// A 1206x2622 iPhone 17 surface: 12464 macroblocks, far past Level 3.1's 3600.
private let nativeWidth = 1206
private let nativeHeight = 2622
private let level31Budget = 3600

final class H264LevelPolicyTests: XCTestCase {
    /// The H.264 block Chrome offers, captured from a live session.
    private let chromeOffer = """
    m=video 9 UDP/TLS/RTP/SAVPF 102 108 116 118
    a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f
    a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f
    a=fmtp:116 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f
    a=fmtp:118 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f
    """

    // MARK: level parsing

    func testReadsLevel31FromAChromeOffer() {
        XCTAssertEqual(H264LevelPolicy.minAdvertisedLevel(sdp: chromeOffer), 31)
    }

    /// The exact bytes `raiseH264OfferLevel` produces, so the two parsers stay in contract.
    func testReadsTheRaisedLevelTheClientActuallySends() {
        let raised = """
        a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=420034
        a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e034
        a=fmtp:118 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640034
        """
        XCTAssertEqual(H264LevelPolicy.minAdvertisedLevel(sdp: raised), 52)
    }

    /// Guessing high removes the bound and the encoder produces nothing; guessing low only
    /// costs picture. So a mixed offer must resolve to the lowest level, not the highest.
    func testTakesTheLowestLevelWhenPayloadsDisagree() {
        let mixed = """
        a=fmtp:108 profile-level-id=640034
        a=fmtp:118 profile-level-id=42e01f
        """
        XCTAssertEqual(H264LevelPolicy.minAdvertisedLevel(sdp: mixed), 31)
    }

    func testReturnsNilWhenTheOfferHasNoH264() {
        XCTAssertNil(H264LevelPolicy.minAdvertisedLevel(sdp: "a=rtpmap:96 VP8/90000"))
    }

    /// `profile-level-id` is exactly 6 hex digits. A longer run read at the wrong offset
    /// yields a high level, which is the direction that breaks encoding.
    func testIgnoresMalformedProfileLevelIds() {
        XCTAssertNil(H264LevelPolicy.minAdvertisedLevel(sdp: "a=fmtp:108 profile-level-id=42e"))
        XCTAssertNil(H264LevelPolicy.minAdvertisedLevel(sdp: "a=fmtp:108 profile-level-id=42001f34"))
        XCTAssertNil(H264LevelPolicy.minAdvertisedLevel(sdp: "a=fmtp:108 profile-level-id=42e01fab"))
        XCTAssertNil(H264LevelPolicy.minAdvertisedLevel(sdp: "a=fmtp:108 profile-level-id=zzzzzz"))
        // A malformed value must not hide a good one alongside it.
        XCTAssertEqual(H264LevelPolicy.minAdvertisedLevel(sdp: """
        a=fmtp:108 profile-level-id=42001f34
        a=fmtp:118 profile-level-id=640034
        """), 52)
    }

    // MARK: macroblocks

    /// Partial macroblocks count as whole ones. Every size here was measured against a real
    /// Level 3.1 session: 588x1280 encoded 40/40 frames, the rest 0/40 with kVTParameterErr.
    func testMacroblocksRoundPartialsUp() {
        XCTAssertEqual(H264LevelPolicy.macroblocks(width: 588, height: 1280), 2960)
        XCTAssertEqual(H264LevelPolicy.macroblocks(width: 651, height: 1416), 3649)
        XCTAssertEqual(H264LevelPolicy.macroblocks(width: 882, height: 1920), 6720)
        XCTAssertEqual(H264LevelPolicy.macroblocks(width: nativeWidth, height: nativeHeight), 12464)
        for (width, height) in [(651, 1416), (736, 1600), (809, 1760), (882, 1920)] {
            XCTAssertGreaterThan(
                H264LevelPolicy.macroblocks(width: width, height: height), level31Budget
            )
        }
        XCTAssertLessThanOrEqual(
            H264LevelPolicy.macroblocks(width: 588, height: 1280), level31Budget
        )
    }

    func testRejectsNonPositiveSizes() {
        XCTAssertEqual(H264LevelPolicy.macroblocks(width: -1, height: 10), 0)
        XCTAssertEqual(H264LevelPolicy.macroblocks(width: 10, height: 0), 0)
    }

    // MARK: level table

    func testLevelTable() {
        XCTAssertEqual(H264LevelPolicy.maxFrameSize(levelIdc: 11), 396)
        XCTAssertEqual(H264LevelPolicy.maxFrameSize(levelIdc: 31), 3600)
        XCTAssertEqual(H264LevelPolicy.maxFrameSize(levelIdc: 41), 8192)
        XCTAssertEqual(H264LevelPolicy.maxFrameSize(levelIdc: 52), 36864)
        XCTAssertEqual(H264LevelPolicy.maxFrameSize(levelIdc: 62), 139_264)
    }

    /// Level 1b is level_idc 11 with constraint_set3_flag, and allows 99 macroblocks where
    /// Level 1.1 allows 396. Reading the last byte alone cannot tell them apart.
    func testLevel1bIsNotLevel11() {
        XCTAssertEqual(H264LevelPolicy.effectiveLevel("42f00b"), 10)
        XCTAssertEqual(H264LevelPolicy.effectiveLevel("4d900b"), 10)
        XCTAssertEqual(H264LevelPolicy.effectiveLevel("42e00b"), 11)
        XCTAssertEqual(H264LevelPolicy.maxFrameSize(levelIdc: 10), 99)
        XCTAssertEqual(H264LevelPolicy.maxFrameSize(levelIdc: 11), 396)
    }

    /// Outside Baseline, Main and Extended, Level 1b is signalled as level_idc 9.
    func testHighProfileLevel1bUsesLevelIdc9() {
        XCTAssertEqual(H264LevelPolicy.maxFrameSize(levelIdc: 9), 99)
        // 352x288 is 396 macroblocks, four times what Level 1b allows.
        XCTAssertGreaterThan(
            H264LevelPolicy.maxLongEdge(sourceWidth: 352, sourceHeight: 288, levelIdc: 9), 0
        )
        XCTAssertEqual(
            H264LevelPolicy.minAdvertisedLevel(sdp: """
            a=rtpmap:96 H264/90000
            a=fmtp:96 profile-level-id=640009
            """),
            9
        )
    }

    /// A payload with no profile-level-id must not be skipped, or a well-specified payload
    /// alongside it raises the floor above the one that might actually be selected.
    func testPayloadWithNoProfileLevelIdStillCounts() {
        let sdp = """
        a=rtpmap:96 H264/90000
        a=rtpmap:97 H264/90000
        a=fmtp:97 profile-level-id=640034
        """
        // RFC 6184 section 8.1 infers Baseline Level 1, and its 99 macroblocks must bind.
        XCTAssertEqual(H264LevelPolicy.minAdvertisedLevel(sdp: sdp), 10)
        XCTAssertEqual(H264LevelPolicy.maxFrameSize(levelIdc: 10), 99)
        XCTAssertEqual(
            H264LevelPolicy.maxLongEdge(sourceWidth: 352, sourceHeight: 288, levelIdc: 10), 176
        )
    }

    /// Encoding names are case-insensitive, so a lowercase rtpmap must not bypass the
    /// absent-parameter inference and fall through to the default.
    func testLowercaseRtpmapStillInfersLevel1() {
        let sdp = """
        m=video 9 UDP/TLS/RTP/SAVPF 96
        a=rtpmap:96 h264/90000
        """
        XCTAssertEqual(H264LevelPolicy.minAdvertisedLevel(sdp: sdp), 10)
        XCTAssertEqual(
            H264LevelPolicy.minAdvertisedLevel(sdp: sdp.replacingOccurrences(of: "h264/", with: "H264/")),
            10
        )
    }

    func testEveryH264PayloadSpecifiedMeansNoInference() {
        let sdp = """
        a=rtpmap:96 H264/90000
        a=fmtp:96 profile-level-id=42e01f
        a=rtpmap:97 H264/90000
        a=fmtp:97 profile-level-id=640034
        """
        XCTAssertEqual(H264LevelPolicy.minAdvertisedLevel(sdp: sdp), 31)
    }

    /// For High profiles the same flag means Intra, not Level 1b.
    func testConstraintSet3OnAHighProfileIsNotLevel1b() {
        XCTAssertEqual(H264LevelPolicy.effectiveLevel("64100b"), 11)
        XCTAssertEqual(H264LevelPolicy.effectiveLevel("f4100b"), 11)
    }

    func testLevel1bScalesA352x288SourceThatLevel11WouldNot() {
        // 352x288 is exactly 396 macroblocks: legal at 1.1, four times over at 1b.
        XCTAssertEqual(
            H264LevelPolicy.maxLongEdge(sourceWidth: 352, sourceHeight: 288, levelIdc: 11), 0
        )
        XCTAssertGreaterThan(
            H264LevelPolicy.maxLongEdge(sourceWidth: 352, sourceHeight: 288, levelIdc: 10),
            0
        )
    }

    func testReadsLevel1bOutOfAnSdpOffer() {
        XCTAssertEqual(
            H264LevelPolicy.minAdvertisedLevel(sdp: "a=fmtp:108 profile-level-id=42f00b"),
            10
        )
    }

    func testUnknownLevelFallsBackToWhatBrowsersAdvertise() {
        XCTAssertEqual(H264LevelPolicy.maxFrameSize(levelIdc: 99), 3600)
        XCTAssertEqual(H264LevelPolicy.maxFrameSize(levelIdc: 0), 3600)
    }

    // MARK: maxLongEdge

    func testDoesNotScaleWhenTheSourceAlreadyFits() {
        XCTAssertEqual(
            H264LevelPolicy.maxLongEdge(
                sourceWidth: nativeWidth, sourceHeight: nativeHeight, levelIdc: 52
            ),
            0
        )
        XCTAssertEqual(
            H264LevelPolicy.maxLongEdge(sourceWidth: 640, sourceHeight: 1136, levelIdc: 31), 0
        )
    }

    func testScalesANativeFrameToTheLargestLongEdgeThatFitsLevel31() {
        XCTAssertEqual(
            H264LevelPolicy.maxLongEdge(
                sourceWidth: nativeWidth, sourceHeight: nativeHeight, levelIdc: 31
            ),
            1392
        )
    }

    func testScalesASmallerSurfaceThatStillDoesNotFit() {
        XCTAssertEqual(
            H264LevelPolicy.maxLongEdge(sourceWidth: 750, sourceHeight: 1334, levelIdc: 31), 1280
        )
    }

    /// The caller sends a scale factor, not a width, so libwebrtc's short edge can land a
    /// pixel or two above ours. Every long edge we return must still fit at that width.
    func testResultFitsEvenWhenTheEncoderRoundsTheShortEdgeUp() {
        for levelIdc in [31, 32, 40, 42] {
            let longEdge = H264LevelPolicy.maxLongEdge(
                sourceWidth: nativeWidth, sourceHeight: nativeHeight, levelIdc: levelIdc
            )
            XCTAssertGreaterThan(longEdge, 0, "level \(levelIdc) should have scaled")
            let scale = Double(nativeHeight) / Double(longEdge)
            let encoderWidth = Int((Double(nativeWidth) / scale).rounded(.up))
            XCTAssertLessThanOrEqual(
                H264LevelPolicy.macroblocks(width: encoderWidth, height: longEdge),
                H264LevelPolicy.maxFrameSize(levelIdc: levelIdc),
                "level \(levelIdc): \(encoderWidth)x\(longEdge) exceeds its budget"
            )
        }
    }

    func testRejectsNonPositiveSources() {
        XCTAssertEqual(
            H264LevelPolicy.maxLongEdge(sourceWidth: 0, sourceHeight: 100, levelIdc: 31), 0
        )
        XCTAssertEqual(
            H264LevelPolicy.maxLongEdge(sourceWidth: 100, sourceHeight: 0, levelIdc: 31), 0
        )
    }
}
