import Foundation

/// Frame sizes an H.264 level allows.
///
/// libwebrtc builds its VideoToolbox session at the level the peer advertised. Past that
/// level's MaxFS, `VTCompressionSessionPrepareToEncodeFrames` fails with `kVTParameterErr`
/// and the session emits no frames at all while still reporting itself connected.
public enum H264LevelPolicy {
    /// Level 1b is `level_idc` 11 *with* constraint_set3_flag, and is far smaller than
    /// Level 1.1, which shares the same byte. Keyed separately rather than by byte alone.
    public static let level1bIdc = -11

    /// MaxFS in macroblocks, H.264 Table A-1, keyed by `level_idc` (31 is Level 3.1).
    static let maxFrameSizeByLevel: [Int: Int] = [
        10: 99, level1bIdc: 99, 11: 396, 12: 396, 13: 396,
        20: 396, 21: 792, 22: 1620,
        30: 1620, 31: 3600, 32: 5120,
        40: 8192, 41: 8192, 42: 8704,
        50: 22080, 51: 36864, 52: 36864,
        60: 139_264, 61: 139_264, 62: 139_264,
    ]

    /// MaxMBPS in macroblocks per second, H.264 Table A-1. A level bounds throughput as
    /// well as frame size, so a frame that fits can still be refused at a high frame rate.
    static let maxMacroblockRateByLevel: [Int: Int] = [
        10: 1485, level1bIdc: 1485, 11: 3000, 12: 6000, 13: 11_880,
        20: 11_880, 21: 19_800, 22: 20_250,
        30: 40_500, 31: 108_000, 32: 216_000,
        40: 245_760, 41: 245_760, 42: 522_240,
        50: 589_824, 51: 983_040, 52: 2_073_600,
        60: 4_177_920, 61: 8_355_840, 62: 16_711_680,
    ]

    /// Assumed when an offer carries H.264 with no parsable level. RFC 6184 defaults to
    /// Level 1, but browsers all advertise 3.1 and 99 macroblocks would cripple them.
    public static let defaultLevelIdc = 31

    private static let profileLevelIdDigits = 6
    private static let constraintSet3Flag = 0x10
    private static let level1bByte = 0x0b
    /// Profiles where constraint_set3_flag means Level 1b. For High profiles it means Intra.
    private static let level1bProfileIdcs: Set<Int> = [66, 77, 88]

    /// Lowest `level_idc` advertised for H.264, or nil if the SDP offers none.
    ///
    /// Lowest wins because the errors are not symmetric: guessing too low costs picture,
    /// guessing too high removes the bound and the encoder produces nothing.
    public static func minAdvertisedLevel(sdp: String) -> Int? {
        var lowest: Int?
        for line in sdp.split(whereSeparator: \.isNewline) {
            for level in levels(in: line) {
                lowest = min(lowest ?? level, level)
            }
        }
        return lowest
    }

    /// `profile-level-id` is exactly 6 hex digits; a longer or shorter run is malformed and
    /// ignored rather than read at the wrong offset.
    private static func levels<S: StringProtocol>(in line: S) -> [Int] {
        var levels: [Int] = []
        var rest = line[line.startIndex...]
        while let marker = rest.range(of: "profile-level-id=") {
            let digits = rest[marker.upperBound...].prefix { $0.isHexDigit }
            if digits.count == profileLevelIdDigits, let level = effectiveLevel(String(digits)) {
                levels.append(level)
            }
            rest = rest[marker.upperBound...]
        }
        return levels
    }

    /// The level a `profile-level-id` really names, which is not always its last byte.
    public static func effectiveLevel(_ profileLevelId: String) -> Int? {
        guard profileLevelId.count == profileLevelIdDigits else { return nil }
        let hex = Array(profileLevelId)
        guard let profileIdc = Int(String(hex[0...1]), radix: 16),
              let profileIop = Int(String(hex[2...3]), radix: 16),
              let levelIdc = Int(String(hex[4...5]), radix: 16)
        else { return nil }
        let isLevel1B = levelIdc == level1bByte
            && profileIop & constraintSet3Flag != 0
            && level1bProfileIdcs.contains(profileIdc)
        return isLevel1B ? level1bIdc : levelIdc
    }

    /// Whether this frame exceeds the level's throughput allowance, which MaxFS alone misses.
    ///
    /// Deliberately NOT used as a bound. Level 3.1 at 60 fps allows only 1800 macroblocks,
    /// yet 640x1392 (3480) encodes there for minutes through libwebrtc with no loss, so
    /// clamping on it would cut resolution below the flat guard this policy replaced.
    /// VideoToolbox does refuse it when told the frame rate directly, so it is worth
    /// reporting: if a session ever encodes nothing at a legal frame size, this is why.
    public static func exceedsMacroblockRate(
        levelIdc: Int,
        width: Int,
        height: Int,
        framesPerSecond: Int
    ) -> Bool {
        guard framesPerSecond > 0 else { return false }
        let rate = maxMacroblockRateByLevel[levelIdc]
            ?? maxMacroblockRateByLevel[defaultLevelIdc] ?? 108_000
        return macroblocks(width: width, height: height) * framesPerSecond > rate
    }

    /// Partial macroblocks count as whole ones.
    public static func macroblocks(width: Int, height: Int) -> Int {
        guard width > 0, height > 0 else { return 0 }
        return ((width + 15) / 16) * ((height + 15) / 16)
    }

    public static func maxFrameSize(levelIdc: Int) -> Int {
        maxFrameSizeByLevel[levelIdc] ?? maxFrameSizeByLevel[defaultLevelIdc] ?? 3600
    }

    /// Largest long edge fitting `levelIdc` at the source aspect ratio, or 0 to not scale.
    ///
    /// Callers pass this as a scale factor, so the short edge libwebrtc derives can land
    /// above ours. The fit is checked against the widest it could produce: 640px is exactly
    /// 40 macroblocks, so one extra column costs a whole one. The long edge is the scale's
    /// own denominator and comes back exact — measured 640x1392 for a 1206x2622 source.
    public static func maxLongEdge(
        sourceWidth: Int,
        sourceHeight: Int,
        levelIdc: Int
    ) -> Int {
        guard sourceWidth > 0, sourceHeight > 0 else { return 0 }
        let budget = maxFrameSize(levelIdc: levelIdc)
        if macroblocks(width: sourceWidth, height: sourceHeight) <= budget { return 0 }

        let longEdge = max(sourceWidth, sourceHeight)
        let shortEdge = min(sourceWidth, sourceHeight)
        // Stepping down beats a closed form: dimensions stay even for 4:2:0, and macroblock
        // rounding would need correcting anyway.
        var candidate = longEdge - (longEdge % 2)
        while candidate > 16 {
            let widest = widestShortEdge(longEdge: candidate, of: shortEdge, over: longEdge)
            let (width, height) = sourceWidth >= sourceHeight
                ? (candidate, widest)
                : (widest, candidate)
            if macroblocks(width: width, height: height) <= budget { return candidate }
            candidate -= 2
        }
        return 16
    }

    /// Ceiling-divided and rounded up to even, so it is never narrower than what the
    /// encoder receives.
    private static func widestShortEdge(longEdge: Int, of shortEdge: Int, over sourceLong: Int) -> Int {
        let scaled = (longEdge * shortEdge + sourceLong - 1) / sourceLong
        return max(16, scaled + (scaled % 2))
    }
}
