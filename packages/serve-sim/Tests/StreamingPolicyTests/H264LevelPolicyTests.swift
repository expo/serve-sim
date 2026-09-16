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

    func testReadsEveryProfileLevelIdOnOneLine() {
        let line = "a=fmtp:108 profile-level-id=640034;x=1 profile-level-id=42e01f"
        XCTAssertEqual(H264LevelPolicy.minAdvertisedLevel(sdp: line), 31)
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
    }

    func testMixesValidAndMalformedValues() {
        let sdp = """
        a=fmtp:108 profile-level-id=42001f34
        a=fmtp:118 profile-level-id=640034
        """
        XCTAssertEqual(H264LevelPolicy.minAdvertisedLevel(sdp: sdp), 52)
    }

    // MARK: macroblocks

    /// Partial macroblocks count as whole ones.
    func testMacroblocksRoundPartialsUp() {
        XCTAssertEqual(H264LevelPolicy.macroblocks(width: 588, height: 1280), 2960)
        XCTAssertEqual(H264LevelPolicy.macroblocks(width: 651, height: 1416), 3649)
        XCTAssertEqual(H264LevelPolicy.macroblocks(width: 882, height: 1920), 6720)
        XCTAssertEqual(H264LevelPolicy.macroblocks(width: nativeWidth, height: nativeHeight), 12464)
    }

    func testRejectsNonPositiveSizes() {
        XCTAssertEqual(H264LevelPolicy.macroblocks(width: -1, height: 10), 0)
        XCTAssertEqual(H264LevelPolicy.macroblocks(width: 10, height: 0), 0)
    }

    /// Every size measured against a real Level 3.1 VideoToolbox session: 588x1280 encoded
    /// 40/40 frames, the rest encoded 0/40 with kVTParameterErr.
    func testMacroblockRulePredictsEveryMeasuredOutcome() {
        XCTAssertEqual(H264LevelPolicy.maxFrameSize(levelIdc: 31), level31Budget)
        XCTAssertLessThanOrEqual(
            H264LevelPolicy.macroblocks(width: 588, height: 1280), level31Budget
        )
        for (width, height) in [(651, 1416), (736, 1600), (809, 1760), (882, 1920), (1206, 2622)] {
            XCTAssertGreaterThan(
                H264LevelPolicy.macroblocks(width: width, height: height), level31Budget
            )
        }
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
        XCTAssertEqual(H264LevelPolicy.effectiveLevel("42f00b"), H264LevelPolicy.level1bIdc)
        XCTAssertEqual(H264LevelPolicy.effectiveLevel("4d900b"), H264LevelPolicy.level1bIdc)
        XCTAssertEqual(H264LevelPolicy.effectiveLevel("42e00b"), 11)
        XCTAssertEqual(H264LevelPolicy.maxFrameSize(levelIdc: H264LevelPolicy.level1bIdc), 99)
        XCTAssertEqual(H264LevelPolicy.maxFrameSize(levelIdc: 11), 396)
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
            H264LevelPolicy.maxLongEdge(
                sourceWidth: 352, sourceHeight: 288, levelIdc: H264LevelPolicy.level1bIdc
            ),
            0
        )
    }

    func testReadsLevel1bOutOfAnSdpOffer() {
        XCTAssertEqual(
            H264LevelPolicy.minAdvertisedLevel(sdp: "a=fmtp:108 profile-level-id=42f00b"),
            H264LevelPolicy.level1bIdc
        )
    }

    /// MaxFS alone is not the whole level. Reported, never clamped on: 640x1392 at 60 fps is
    /// past Level 3.1's allowance yet encodes fine through libwebrtc.
    func testMacroblockRateIsReportedNotEnforced() {
        XCTAssertTrue(H264LevelPolicy.exceedsMacroblockRate(
            levelIdc: 31, width: 640, height: 1392, framesPerSecond: 60
        ))
        XCTAssertFalse(H264LevelPolicy.exceedsMacroblockRate(
            levelIdc: 31, width: 640, height: 1392, framesPerSecond: 30
        ))
        XCTAssertFalse(H264LevelPolicy.exceedsMacroblockRate(
            levelIdc: 31, width: 640, height: 1392, framesPerSecond: 0
        ))
        // The bound itself must stay MaxFS-only, or a 60 fps session drops below the old guard.
        XCTAssertEqual(
            H264LevelPolicy.maxLongEdge(sourceWidth: 1206, sourceHeight: 2622, levelIdc: 31), 1392
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

    func testLandscapeGivesTheSameLongEdge() {
        XCTAssertEqual(
            H264LevelPolicy.maxLongEdge(
                sourceWidth: nativeHeight, sourceHeight: nativeWidth, levelIdc: 31
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
