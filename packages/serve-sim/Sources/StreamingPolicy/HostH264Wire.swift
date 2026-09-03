import Foundation

public enum HostH264Plan {
    public static let defaultHost = "192.168.64.1"
    public static let defaultPort: UInt16 = 9876

    /// Host AVE sidecar instead of in-process VideoToolbox.
    /// `hostEncoderFlag` is `SERVE_SIM_HOST_ENCODER` (`1`/`true` on, `0`/`false` off).
    /// Unset: Tart (`Virtual*`) uses the sidecar, a real Mac uses in-process VT.
    public static func usesHostSocket(isVirtualMac: Bool, hostEncoderFlag: String?) -> Bool {
        if flagOn(hostEncoderFlag) { return true }
        if flagOff(hostEncoderFlag) { return false }
        return isVirtualMac
    }

    public static func host(from environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        let raw = environment["SERVE_SIM_HOST_ENCODER_HOST"]?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return raw.isEmpty ? defaultHost : raw
    }

    public static func nv12SendSize(
        width: Int,
        height: Int,
        maxLongEdge: Int = 0
    ) -> (width: Int, height: Int)? {
        var width = width
        var height = height
        if width % 2 != 0 { width -= 1 }
        if height % 2 != 0 { height -= 1 }
        let sized = SnapshotSizePolicy(width: width, height: height, maxDimension: maxLongEdge)
        width = sized.width
        height = sized.height
        if width % 2 != 0 { width -= 1 }
        if height % 2 != 0 { height -= 1 }
        guard width >= 16, height >= 16 else { return nil }
        return (width, height)
    }

    /// LiveKit `setBitrate` is kilobits. RATE and VT AverageBitRate are bits.
    public static func bitsPerSecond(fromKilobits kbps: UInt32) -> UInt32 {
        let bps = UInt64(kbps) * 1_000
        return UInt32(min(max(bps, 100_000), 50_000_000))
    }

    public static func port(from environment: [String: String] = ProcessInfo.processInfo.environment) -> UInt16 {
        guard let raw = environment["SERVE_SIM_HOST_ENCODER_PORT"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            let parsed = UInt16(raw),
            parsed > 0
        else {
            return defaultPort
        }
        return parsed
    }

    static func flagOn(_ value: String?) -> Bool {
        switch value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "1", "true", "yes", "on":
            return true
        default:
            return false
        }
    }

    static func flagOff(_ value: String?) -> Bool {
        switch value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "0", "false", "no", "off":
            return true
        default:
            return false
        }
    }
}

/// Guest↔host encoder framing. Header is always 12 bytes so RATE and NV12 share a read size.
///
///   C→S  "NV12" | w:u16be | h:u16be | pts:u32be   then n:u32be | pixels
///        w bit15 = force IDR
///   C→S  "RATE" | bitrate:u32be | pad:u32be      (no reply)
///   S→C  "AVCC" | flags:u8 | pts:u32be | n:u32be | avcc
public enum HostH264Wire {
    public static let headerSize = 12
    public static let keyframeBit = 0x8000
    public static let nv12Magic = Data("NV12".utf8)
    public static let avccMagic = Data("AVCC".utf8)
    public static let rateMagic = Data("RATE".utf8)

    public static func nv12Header(width: Int, height: Int, pts: UInt32, forceKeyframe: Bool) -> Data {
        var data = nv12Magic
        let packed = (max(0, width) & 0x7FFF) | (forceKeyframe ? keyframeBit : 0)
        appendU16(&data, packed)
        appendU16(&data, max(0, height) & 0xFFFF)
        appendU32(&data, pts)
        return data
    }

    public static func parseNV12Header(_ header: Data) -> (width: Int, height: Int, pts: UInt32, forceKeyframe: Bool)? {
        guard header.count == headerSize, header.prefix(4) == nv12Magic else { return nil }
        let packed = Int(readU16(header, 4))
        return (packed & 0x7FFF, Int(readU16(header, 6)), readU32(header, 8), packed & keyframeBit != 0)
    }

    public static func pixelCountHeader(_ count: Int) -> Data {
        var data = Data()
        appendU32(&data, UInt32(max(0, count)))
        return data
    }

    public static func rateHeader(bitrate: UInt32) -> Data {
        var data = rateMagic
        appendU32(&data, bitrate)
        appendU32(&data, 0)
        return data
    }

    public static func parseRateHeader(_ header: Data) -> UInt32? {
        guard header.count == headerSize, header.prefix(4) == rateMagic else { return nil }
        return readU32(header, 4)
    }

    public static func annexB(fromAVCC data: Data) -> Data {
        var out = Data()
        var offset = 0
        let start = Data([0, 0, 0, 1])
        while offset + 4 <= data.count {
            let n = Int(data[offset]) << 24 | Int(data[offset + 1]) << 16
                | Int(data[offset + 2]) << 8 | Int(data[offset + 3])
            offset += 4
            guard n > 0, offset + n <= data.count else { break }
            out.append(start)
            out.append(data[offset ..< (offset + n)])
            offset += n
        }
        return out
    }
}

private func appendU16(_ data: inout Data, _ value: Int) {
    data.append(UInt8((value >> 8) & 0xFF))
    data.append(UInt8(value & 0xFF))
}

private func appendU32(_ data: inout Data, _ value: UInt32) {
    data.append(UInt8((value >> 24) & 0xFF))
    data.append(UInt8((value >> 16) & 0xFF))
    data.append(UInt8((value >> 8) & 0xFF))
    data.append(UInt8(value & 0xFF))
}

private func readU16(_ data: Data, _ offset: Int) -> UInt16 {
    (UInt16(data[offset]) << 8) | UInt16(data[offset + 1])
}

private func readU32(_ data: Data, _ offset: Int) -> UInt32 {
    (UInt32(data[offset]) << 24) | (UInt32(data[offset + 1]) << 16)
        | (UInt32(data[offset + 2]) << 8) | UInt32(data[offset + 3])
}
