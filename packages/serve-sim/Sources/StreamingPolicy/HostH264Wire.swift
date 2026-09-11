import Foundation

public enum HostH264Plan {
    public static let defaultHost = "192.168.64.1"
    public static let defaultPort: UInt16 = 9876
    public static let hostEncoderID = "host-ave.avc"
    /// Long-edge cap when the sidecar would otherwise send native iPhone NV12 over vmnet.
    public static let hostSocketDefaultMaxLongEdge = 1280

    /// Host AVE sidecar instead of in-process VideoToolbox.
    /// `hostEncoderFlag` is `SERVE_SIM_HOST_ENCODER` (`1`/`true` on, `0`/`false` off).
    /// Unset: Tart (`Virtual*`) uses the sidecar, a real Mac uses in-process VT.
    public static func usesHostSocket(isVirtualMac: Bool, hostEncoderFlag: String?) -> Bool {
        if flagOn(hostEncoderFlag) { return true }
        if flagOff(hostEncoderFlag) { return false }
        return isVirtualMac
    }

    /// Native (`0`) on the host socket becomes 1280. A real Mac in-process VT stays native.
    public static func sendMaxLongEdge(configuredMaxDimension: Int, usesHostSocket: Bool) -> Int {
        if configuredMaxDimension > 0 { return configuredMaxDimension }
        return usesHostSocket ? hostSocketDefaultMaxLongEdge : 0
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

    /// Long-edge cap for WebRTC H.264 encoding on a virtualised guest.
    ///
    /// Native Retina simulator surfaces are over 3 MP. Measured on Tart: at 1206x2622 the
    /// H.264 session connected, ran a few hundred frames, then ICE dropped and the client's
    /// h264->vp8 ladder fell back to software VP8. Capped at 1280 the same session held
    /// past 3300 frames at 60 fps with no loss. An explicit setting always wins.
    public static func encodeMaxLongEdge(configuredMaxDimension: Int, isVirtualMac: Bool) -> Int {
        if configuredMaxDimension > 0 { return configuredMaxDimension }
        return isVirtualMac ? hostSocketDefaultMaxLongEdge : 0
    }

    /// Which encoder a WebRTC H.264 session should use, once the explicit
    /// disable/force env flags have already been handled.
    public enum H264EncoderChoice: Equatable, Sendable {
        /// Ship NV12 to the host sidecar on :9876.
        case hostSocket
        /// Probe the guest's in-process VideoToolbox. On Tart that is the host AVE.
        case guestVideoToolbox
    }

    /// The sidecar being unreachable says nothing about the guest's own encoder, so a
    /// missing sidecar falls through to guest VideoToolbox rather than disabling H.264.
    /// Returning "disabled" here is what quietly dropped Tart streams to software VP8 at
    /// native resolution while a working hardware encoder sat unprobed in the guest.
    ///
    /// This still fails closed for the *sidecar* claim: the caller reports
    /// `usesHost=false` and the real guest encoder id, so nothing pretends the host
    /// encoded a frame it never saw.
    public static func encoderChoice(
        isVirtualMac: Bool,
        hostEncoderFlag: String?,
        hostSocketReachable: Bool
    ) -> H264EncoderChoice {
        guard usesHostSocket(isVirtualMac: isVirtualMac, hostEncoderFlag: hostEncoderFlag) else {
            return .guestVideoToolbox
        }
        return hostSocketReachable ? .hostSocket : .guestVideoToolbox
    }

    /// A Tart guest exposes `paravirtualized:com.apple.videotoolbox.videoencoder.ave.avc`:
    /// the host AVE, reached through the VideoToolbox device that
    /// `VZMacGraphicsDeviceConfiguration` attaches implicitly (macOS 15.4+ host, macOS 14+
    /// guest). No entitlement and no SIP change are involved.
    ///
    /// Measured host 26.5.1 / guest 26.3: ~350 fps at 590x1280 on ~0.24 CPU cores, and a
    /// guest under load drops host AVE throughput 482 -> 81 fps, so the silicon is shared.
    /// Skipping this probe on VirtualMac disabled a working hardware encoder and fell back
    /// to software VP8, so the guest always gets probed now.
    public static func probesGuestVideoToolbox(isVirtualMac _: Bool) -> Bool {
        true
    }

    /// `nil` when the identifier says nothing either way. The `paravirtualized:` prefix is
    /// the guest's view of the host AVE and counts as hardware.
    public static func isHardwareEncoderID(_ encoderID: String?) -> Bool? {
        guard let encoderID else { return nil }
        let normalized = encoderID.lowercased()
        if normalized.contains("paravirtualized") || normalized.contains(".ave.") {
            return true
        }
        if normalized.contains("videoencoder.h264") || normalized.contains("videoencoder.hevc") {
            return false
        }
        return nil
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
