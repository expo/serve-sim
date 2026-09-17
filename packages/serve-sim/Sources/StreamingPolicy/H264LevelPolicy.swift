import Foundation

/// Frame sizes an H.264 level allows. Past MaxFS the VideoToolbox session emits no frames
/// at all while still reporting itself connected.
///
/// Reads what `src/client/webrtc-sdp-level.ts` writes; the two must agree on the format.
public enum H264LevelPolicy {
    /// MaxFS in macroblocks, H.264 Table A-1, keyed by `level_idc` (31 is Level 3.1).
    /// 9 is how Level 1b is signalled outside Baseline, Main and Extended; it shares
    /// Level 1.0's 99.
    static let maxFrameSizeByLevel: [Int: Int] = [
        9: 99, 10: 99, 11: 396, 12: 396, 13: 396,
        20: 396, 21: 792, 22: 1620,
        30: 1620, 31: 3600, 32: 5120,
        40: 8192, 41: 8192, 42: 8704,
        50: 22080, 51: 36864, 52: 36864,
        60: 139_264, 61: 139_264, 62: 139_264,
    ]

    /// Assumed when an offer carries H.264 with no parsable level. RFC 6184 defaults to
    /// Level 1, but browsers all advertise 3.1 and 99 macroblocks would cripple them.
    public static let defaultLevelIdc = 31

    private static let profileLevelIdDigits = 6
    private static let constraintSet3Flag = 0x10
    private static let level1bByte = 0x0b
    /// Profiles where constraint_set3_flag means Level 1b. For High profiles it means Intra.
    private static let level1bProfileIdcs: Set<Int> = [0x42, 0x4d, 0x58]

    /// Lowest wins: guessing high removes the bound and the encoder emits nothing.
    ///
    /// A payload carrying no `profile-level-id` still counts, or one well-specified payload
    /// could raise the floor above a bare one that libwebrtc might actually select.
    ///
    /// An absent parameter means Baseline Level 1 (RFC 6184 section 8.1), so that is what it
    /// counts as. Assuming better would hand a peer frames it never said it could decode, and
    /// nothing reliably catches that: a decoder can limp rather than stop.
    public static func minAdvertisedLevel(sdp: String) -> Int? {
        var found = levels(in: sdp)
        if h264PayloadCount(in: sdp) > found.count { found.append(absentParameterLevelIdc) }
        return found.min()
    }

    /// RFC 6184 section 8.1: Baseline Level 1 when `profile-level-id` is absent.
    static let absentParameterLevelIdc = 10

    private static func h264PayloadCount(in sdp: String) -> Int {
        var count = 0
        var rest = sdp[sdp.startIndex...]
        while let marker = rest.range(of: "a=rtpmap:") {
            let line = rest[marker.upperBound...].prefix { !$0.isNewline }
            // Encoding names are case-insensitive (RFC 8866 section 5.14).
            if line.range(of: "H264/", options: .caseInsensitive) != nil { count += 1 }
            rest = rest[marker.upperBound...]
        }
        return count
    }

    /// `profile-level-id` is exactly 6 hex digits; a longer or shorter run is malformed and
    /// ignored rather than read at the wrong offset.
    private static func levels(in sdp: String) -> [Int] {
        var levels: [Int] = []
        var rest = sdp[sdp.startIndex...]
        while let marker = rest.range(of: "profile-level-id=") {
            let digits = rest[marker.upperBound...].prefix { $0.isHexDigit }
            if digits.count == profileLevelIdDigits, let level = effectiveLevel(String(digits)) {
                levels.append(level)
            }
            rest = rest[marker.upperBound...]
        }
        return levels
    }

    /// Not always the last byte: Level 1b is `level_idc` 11 plus constraint_set3_flag, and
    /// allows 99 macroblocks where Level 1.1 allows 396. It shares Level 1.0's limits.
    static func effectiveLevel(_ profileLevelId: String) -> Int? {
        guard profileLevelId.count == profileLevelIdDigits else { return nil }
        let hex = Array(profileLevelId)
        guard let profileIdc = Int(String(hex[0...1]), radix: 16),
              let profileIop = Int(String(hex[2...3]), radix: 16),
              let levelIdc = Int(String(hex[4...5]), radix: 16)
        else { return nil }
        let isLevel1B = levelIdc == level1bByte
            && profileIop & constraintSet3Flag != 0
            && level1bProfileIdcs.contains(profileIdc)
        return isLevel1B ? 10 : levelIdc
    }

    /// Partial macroblocks count as whole ones.
    public static func macroblocks(width: Int, height: Int) -> Int {
        guard width > 0, height > 0 else { return 0 }
        return ((width + 15) / 16) * ((height + 15) / 16)
    }

    public static func maxFrameSize(levelIdc: Int) -> Int {
        maxFrameSizeByLevel[levelIdc] ?? maxFrameSizeByLevel[defaultLevelIdc]!
    }

    /// Largest long edge that fits the level, or 0 when the source already fits.
    public static func maxLongEdge(sourceWidth: Int, sourceHeight: Int, levelIdc: Int) -> Int {
        guard sourceWidth > 0, sourceHeight > 0 else { return 0 }
        let budget = maxFrameSize(levelIdc: levelIdc)
        if macroblocks(width: sourceWidth, height: sourceHeight) <= budget { return 0 }

        let longEdge = max(sourceWidth, sourceHeight)
        let shortEdge = min(sourceWidth, sourceHeight)
        // Stepping down beats a closed form: dimensions stay even for 4:2:0 anyway.
        var candidate = longEdge - (longEdge % 2)
        while candidate > 16 {
            // The caller sends a scale, so the short edge libwebrtc derives can land above
            // ours. Round up: 640px is exactly 40 macroblocks, so one column costs a whole one.
            let scaled = (candidate * shortEdge + longEdge - 1) / longEdge
            if macroblocks(width: candidate, height: max(16, scaled + scaled % 2)) <= budget {
                return candidate
            }
            candidate -= 2
        }
        return 16
    }
}
