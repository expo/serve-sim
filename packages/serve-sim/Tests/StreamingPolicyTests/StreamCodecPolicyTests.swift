import XCTest
@testable import StreamingPolicy

final class StreamCodecPolicyTests: XCTestCase {
    func testIsH264IsCaseInsensitive() {
        XCTAssertTrue(StreamCodecPolicy.isH264("H264"))
        XCTAssertTrue(StreamCodecPolicy.isH264("h264"))
        XCTAssertFalse(StreamCodecPolicy.isH264("VP8"))
        XCTAssertFalse(StreamCodecPolicy.isH264(""))
    }

    func testDominantPrefersH264SoOneSoftwareSessionCannotMaskIt() {
        XCTAssertEqual(StreamCodecPolicy.dominant(["VP8", "H264"]), "H264")
        XCTAssertEqual(StreamCodecPolicy.dominant(["h264", "VP8"]), "h264")
        XCTAssertEqual(StreamCodecPolicy.dominant(["VP8", "VP9"]), "VP8")
        XCTAssertEqual(StreamCodecPolicy.dominant(["", "VP8"]), "VP8")
        XCTAssertNil(StreamCodecPolicy.dominant([]))
        XCTAssertNil(StreamCodecPolicy.dominant(["", ""]))
    }

    func testCodecNameFromMimeType() {
        XCTAssertEqual(StreamCodecPolicy.codecName(fromMimeType: "video/H264"), "H264")
        XCTAssertEqual(StreamCodecPolicy.codecName(fromMimeType: "video/VP8"), "VP8")
        XCTAssertNil(StreamCodecPolicy.codecName(fromMimeType: "video/"))
        XCTAssertNil(StreamCodecPolicy.codecName(fromMimeType: ""))
    }
}
