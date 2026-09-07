// Reports whether this machine has a usable hardware H.264 encoder, and how fast it is.
//
// Runs anywhere: bare metal, a Tart/VZ guest, or a CI runner. Self-contained, no deps.
//
//   xcrun swiftc -O guest-encoder-probe.swift -o probe && ./probe
//   ./probe --json          machine-readable one-liner
//
// Why this exists: a macOS guest under Virtualization.framework can reach the host's
// AVE through the VideoToolbox device that VZMacGraphicsDeviceConfiguration attaches
// implicitly (host macOS 15.4+, guest macOS 14+). The guest then reports encoder id
// `paravirtualized:com.apple.videotoolbox.videoencoder.ave.avc`. No entitlement and no
// SIP change are needed. Neither `UsingHardwareAcceleratedVideoEncoder` nor per-process
// CPU proves this, so the probe reports sustained throughput, which does.
//
// Reading the result: hardware sustains hundreds of fps at 590x1280 for a fraction of a
// core. Software manages single digits, or stalls outright.
import VideoToolbox
import CoreVideo
import Foundation

let json = CommandLine.arguments.contains("--json")
let W: Int32 = 590, H: Int32 = 1280
let seconds = 5.0

func hwModel() -> String {
    var n = 0; sysctlbyname("hw.model", nil, &n, nil, 0)
    var b = [CChar](repeating: 0, count: n); sysctlbyname("hw.model", &b, &n, nil, 0)
    return String(cString: b)
}
func cpuSeconds() -> Double {
    var u = rusage(); getrusage(RUSAGE_SELF, &u)
    return Double(u.ru_utime.tv_sec) + Double(u.ru_utime.tv_usec) / 1e6
         + Double(u.ru_stime.tv_sec) + Double(u.ru_stime.tv_usec) / 1e6
}

var encoders: [String] = []
var list: CFArray?
if VTCopyVideoEncoderList(nil, &list) == noErr, let arr = list as? [[String: Any]] {
    for e in arr {
        let ct = e[kVTVideoEncoderList_CodecType as String] as? Int ?? 0
        var f = ""; for s in stride(from: 24, through: 0, by: -8) {
            f.append(Character(UnicodeScalar(UInt8((ct >> s) & 0xFF)))) }
        if f == "avc1", let id = e[kVTVideoEncoderList_EncoderID as String] as? String { encoders.append(id) }
    }
}

var session: VTCompressionSession?
let created = VTCompressionSessionCreate(
    allocator: kCFAllocatorDefault, width: W, height: H, codecType: kCMVideoCodecType_H264,
    encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
    outputCallback: nil, refcon: nil, compressionSessionOut: &session)

var encoderID = "none", frames = 0, bytes = 0
var fps = 0.0, cpuCores = 0.0
if created == noErr, let s = session {
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: 60))
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: 6_000_000))
    _ = VTCompressionSessionPrepareToEncodeFrames(s)
    var id: CFString?
    VTSessionCopyProperty(s, key: kVTCompressionPropertyKey_EncoderID, allocator: nil, valueOut: &id)
    encoderID = id.map { $0 as String } ?? "unknown"

    var pb: CVPixelBuffer?
    CVPixelBufferCreate(kCFAllocatorDefault, Int(W), Int(H),
        kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        [kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any]] as CFDictionary, &pb)
    if let buf = pb {
        let c0 = cpuSeconds(), t0 = CFAbsoluteTimeGetCurrent()
        var i = 0
        while CFAbsoluteTimeGetCurrent() - t0 < seconds {
            i += 1
            CVPixelBufferLockBaseAddress(buf, [])
            if let y = CVPixelBufferGetBaseAddressOfPlane(buf, 0) {
                memset(y, Int32(i % 251), CVPixelBufferGetBytesPerRowOfPlane(buf, 0) * 16)
            }
            CVPixelBufferUnlockBaseAddress(buf, [])
            let sem = DispatchSemaphore(value: 0)
            VTCompressionSessionEncodeFrame(
                s, imageBuffer: buf,
                presentationTimeStamp: CMTime(value: CMTimeValue(i), timescale: 60),
                duration: .invalid, frameProperties: nil, infoFlagsOut: nil
            ) { st, _, sb in
                defer { sem.signal() }
                guard st == noErr, let sb, let bb = CMSampleBufferGetDataBuffer(sb) else { return }
                frames += 1; bytes += CMBlockBufferGetDataLength(bb)
            }
            _ = sem.wait(timeout: .now() + 5)
        }
        let wall = CFAbsoluteTimeGetCurrent() - t0
        fps = Double(frames) / wall
        cpuCores = (cpuSeconds() - c0) / wall
    }
    VTCompressionSessionInvalidate(s)
}

// Hardware clears this comfortably; software is nowhere near it.
let verdict = (frames > 0 && fps >= 100 && cpuCores < 1.5) ? "hardware"
            : (frames == 0 ? "broken" : "software-or-degraded")

if json {
    let out: [String: Any] = [
        "hwModel": hwModel(), "os": ProcessInfo.processInfo.operatingSystemVersionString,
        "cores": ProcessInfo.processInfo.activeProcessorCount, "createStatus": created,
        "encoderID": encoderID, "avcEncoders": encoders,
        "fps": round(fps), "cpuCores": (cpuCores * 100).rounded() / 100,
        "frames": frames, "bytes": bytes, "verdict": verdict,
    ]
    let d = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
    print(String(decoding: d, as: UTF8.self))
} else {
    print("hw.model     : \(hwModel())")
    print("os           : \(ProcessInfo.processInfo.operatingSystemVersionString)")
    print("cores        : \(ProcessInfo.processInfo.activeProcessorCount)")
    print("avc encoders : \(encoders.joined(separator: "\n               "))")
    print("session      : createStatus=\(created) encoderID=\(encoderID)")
    print("throughput   : \(Int(fps)) fps at 590x1280, \(String(format: "%.2f", cpuCores)) CPU cores")
    print("VERDICT      : \(verdict)")
}
exit(verdict == "hardware" ? 0 : 1)
