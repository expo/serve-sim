import CoreVideo
import Darwin
import Foundation
import LiveKitWebRTC
import StreamingPolicy
import VideoToolbox

private let webrtcCodecOK: Int = 0
private let webrtcCodecError: Int = -1

final class HostH264EncoderFactory: NSObject, LKRTCVideoEncoderFactory {
    private let fallback = LKRTCDefaultVideoEncoderFactory()
    private let lock = NSLock()
    private var live: HostH264VideoEncoder?

    func createEncoder(_ info: LKRTCVideoCodecInfo) -> LKRTCVideoEncoder? {
        if info.name.caseInsensitiveCompare("H264") == .orderedSame {
            lock.lock()
            defer { lock.unlock() }
            live?.retire()
            let encoder = HostH264VideoEncoder()
            encoder.onRelease = { [weak self, weak encoder] in
                self?.lock.lock()
                if self?.live === encoder {
                    self?.live = nil
                }
                self?.lock.unlock()
            }
            live = encoder
            return encoder
        }
        return fallback.createEncoder(info)
    }

    func supportedCodecs() -> [LKRTCVideoCodecInfo] {
        fallback.supportedCodecs()
    }
}

final class HostH264VideoEncoder: NSObject, LKRTCVideoEncoder {
    private var callback: ((LKRTCEncodedImage, any LKRTCCodecSpecificInfo) -> Bool)?
    private let socket = HostEncoderSocket()
    var onRelease: (() -> Void)?

    var resolutionAlignment: Int { 2 }
    var applyAlignmentToAllSimulcastLayers: Bool { false }
    var supportsNativeHandle: Bool { true }

    func setCallback(_ callback: ((LKRTCEncodedImage, any LKRTCCodecSpecificInfo) -> Bool)?) {
        self.callback = callback
    }

    func startEncode(with settings: LKRTCVideoEncoderSettings, numberOfCores _: Int32) -> Int {
        do {
            try socket.setRate(
                HostH264Plan.bitsPerSecond(fromKilobits: settings.startBitrate),
                framerate: settings.maxFramerate
            )
            try socket.ensureConnected()
            return webrtcCodecOK
        } catch {
            return webrtcCodecError
        }
    }

    func release() -> Int {
        socket.stop()
        callback = nil
        onRelease?()
        onRelease = nil
        return webrtcCodecOK
    }

    func retire() {
        onRelease = nil
        callback = nil
        socket.stop()
    }

    func encode(
        _ frame: LKRTCVideoFrame,
        codecSpecificInfo _: (any LKRTCCodecSpecificInfo)?,
        frameTypes: [NSNumber]
    ) -> Int {
        let forceKey = frameTypes.contains {
            $0.intValue == Int(LKRTCFrameType.videoFrameKey.rawValue)
        }
        guard let cv = frame.buffer as? LKRTCCVPixelBuffer else { return webrtcCodecError }
        do {
            guard let encoded = try socket.encode(
                cv.pixelBuffer,
                forceKeyframe: forceKey
            ) else {
                return webrtcCodecOK
            }
            guard let callback else { return webrtcCodecOK }
            let image = LKRTCEncodedImage()
            image.buffer = encoded.annexB
            image.encodedWidth = Int32(encoded.width)
            image.encodedHeight = Int32(encoded.height)
            image.timeStamp = UInt32(bitPattern: frame.timeStamp)
            image.captureTimeMs = frame.timeStampNs / 1_000_000
            image.frameType = encoded.idr ? .videoFrameKey : .videoFrameDelta
            image.rotation = frame.rotation
            image.contentType = .unspecified
            let info = LKRTCCodecSpecificInfoH264()
            info.packetizationMode = .nonInterleaved
            _ = callback(image, info)
            return webrtcCodecOK
        } catch {
            return webrtcCodecError
        }
    }

    func setBitrate(_ bitrateKbit: UInt32, framerate: UInt32) -> Int32 {
        do {
            try socket.setRate(HostH264Plan.bitsPerSecond(fromKilobits: bitrateKbit), framerate: framerate)
            return 0
        } catch {
            return Int32(webrtcCodecError)
        }
    }

    func implementationName() -> String {
        "host-ave.avc"
    }

    func scalingSettings() -> LKRTCVideoEncoderQpThresholds? {
        nil
    }
}

final class HostEncoderSocket {
    private let io = NSLock()
    private var fd: Int32 = -1
    private var pts: UInt32 = 0
    private var transfer: VTPixelTransferSession?
    private var nv12Buffer: CVPixelBuffer?
    private var nv12Width = 0
    private var nv12Height = 0
    private var nv12Format: OSType = 0
    private var bitrate: UInt32 = 6_000_000

    struct Encoded {
        var annexB: Data
        var idr: Bool
        var width: Int
        var height: Int
    }

    static func sidecarListening(host: String, port: UInt16, timeoutMs: Int32 = 400) -> Bool {
        let sock = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return false }
        var linger = linger(l_onoff: 1, l_linger: 0)
        setsockopt(sock, SOL_SOCKET, SO_LINGER, &linger, socklen_t(MemoryLayout<linger>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        let ok = host.withCString { inet_pton(AF_INET, $0, &addr.sin_addr) == 1 }
        defer { Darwin.close(sock) }
        guard ok else { return false }
        do {
            try connectTimed(sock, addr, timeoutMs: timeoutMs)
            return true
        } catch {
            return false
        }
    }

    func ensureConnected() throws {
        io.lock()
        defer { io.unlock() }
        try connectLocked()
    }

    func setRate(_ bitrate: UInt32, framerate _: UInt32) throws {
        io.lock()
        defer { io.unlock() }
        self.bitrate = max(100_000, min(bitrate, 50_000_000))
        guard fd >= 0 else { return }
        try writeAll(HostH264Wire.rateHeader(bitrate: self.bitrate))
    }

    func encode(_ source: CVPixelBuffer, forceKeyframe: Bool) throws -> Encoded? {
        guard let packed = packedNV12(source) else {
            throw HostEncoderError.badFrame
        }
        io.lock()
        defer { io.unlock() }
        try connectLocked()
        pts &+= 1
        try writeAll(
            HostH264Wire.nv12Header(
                width: packed.width,
                height: packed.height,
                pts: pts,
                forceKeyframe: forceKeyframe
            )
        )
        try writeAll(HostH264Wire.pixelCountHeader(packed.pixels.count))
        try writeAll(packed.pixels)
        let reply = try recvAVCC()
        if reply.payload.isEmpty { return nil }
        let annexB = HostH264Wire.annexB(fromAVCC: reply.payload)
        guard !annexB.isEmpty else { return nil }
        return Encoded(annexB: annexB, idr: reply.idr, width: packed.width, height: packed.height)
    }

    func stop() {
        io.lock()
        defer { io.unlock() }
        closeLocked()
    }

    deinit {
        stop()
        if let transfer { VTPixelTransferSessionInvalidate(transfer) }
    }

    private func connectLocked() throws {
        if fd >= 0 { return }
        let sock = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { throw HostEncoderError.connect }
        var yes: Int32 = 1
        setsockopt(sock, IPPROTO_TCP, TCP_NODELAY, &yes, socklen_t(MemoryLayout<Int32>.size))
        setsockopt(sock, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = HostH264Plan.port().bigEndian
        let ip = HostH264Plan.host()
        guard inet_pton(AF_INET, ip, &addr.sin_addr) == 1 else {
            Darwin.close(sock)
            throw HostEncoderError.connect
        }
        do {
            try Self.connectTimed(sock, addr, timeoutMs: 2000)
        } catch {
            Darwin.close(sock)
            throw error
        }
        fd = sock
        try writeAll(HostH264Wire.rateHeader(bitrate: bitrate))
    }

    private func closeLocked() {
        if fd >= 0 {
            Darwin.close(fd)
            fd = -1
        }
        pts = 0
    }

    private static func connectTimed(_ sock: Int32, _ addr: sockaddr_in, timeoutMs: Int32) throws {
        let flags = fcntl(sock, F_GETFL, 0)
        guard flags >= 0 else { throw HostEncoderError.connect }
        _ = fcntl(sock, F_SETFL, flags | O_NONBLOCK)
        var addr = addr
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        let restore = { _ = fcntl(sock, F_SETFL, flags) }
        if rc == 0 {
            restore()
            return
        }
        if errno != EINPROGRESS {
            restore()
            throw HostEncoderError.connect
        }
        var pfd = pollfd(fd: sock, events: Int16(POLLOUT), revents: 0)
        let pr = withUnsafeMutablePointer(to: &pfd) { poll($0, 1, timeoutMs) }
        restore()
        guard pr > 0, pfd.revents & Int16(POLLOUT) != 0 else { throw HostEncoderError.connect }
        var soError: Int32 = 0
        var len = socklen_t(MemoryLayout<Int32>.size)
        getsockopt(sock, SOL_SOCKET, SO_ERROR, &soError, &len)
        guard soError == 0 else { throw HostEncoderError.connect }
    }

    private func recvAVCC() throws -> (idr: Bool, payload: Data) {
        guard try readExact(4) == HostH264Wire.avccMagic else { throw HostEncoderError.proto }
        let rest = try readExact(9)
        let n = (UInt32(rest[5]) << 24) | (UInt32(rest[6]) << 16) | (UInt32(rest[7]) << 8) | UInt32(rest[8])
        guard n <= 8_000_000 else { throw HostEncoderError.proto }
        let payload = try readExact(Int(n))
        return (rest[0] & 1 != 0, payload)
    }

    private func packedNV12(_ source: CVPixelBuffer) -> (pixels: Data, width: Int, height: Int)? {
        guard let sized = HostH264Plan.nv12SendSize(
            width: CVPixelBufferGetWidth(source),
            height: CVPixelBufferGetHeight(source)
        ) else { return nil }
        let width = sized.width
        let height = sized.height
        guard let nv12 = nv12PixelBuffer(from: source, width: width, height: height) else { return nil }
        CVPixelBufferLockBaseAddress(nv12, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(nv12, .readOnly) }
        guard
            let ySrc = CVPixelBufferGetBaseAddressOfPlane(nv12, 0),
            let uvSrc = CVPixelBufferGetBaseAddressOfPlane(nv12, 1)
        else { return nil }
        let yStride = CVPixelBufferGetBytesPerRowOfPlane(nv12, 0)
        let uvStride = CVPixelBufferGetBytesPerRowOfPlane(nv12, 1)
        let ySize = width * height
        var out = Data(count: ySize + ySize / 2)
        out.withUnsafeMutableBytes { raw in
            let dst = raw.bindMemory(to: UInt8.self).baseAddress!
            for row in 0 ..< height {
                memcpy(dst.advanced(by: row * width), ySrc.advanced(by: row * yStride), width)
            }
            let uvDst = dst.advanced(by: ySize)
            for row in 0 ..< (height / 2) {
                memcpy(uvDst.advanced(by: row * width), uvSrc.advanced(by: row * uvStride), width)
            }
        }
        return (out, width, height)
    }

    private func nv12PixelBuffer(from source: CVPixelBuffer, width: Int, height: Int) -> CVPixelBuffer? {
        let format = CVPixelBufferGetPixelFormatType(source)
        let destFormat: OSType = format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            ? kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        let alreadyNV12 = format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            || format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        if alreadyNV12,
           CVPixelBufferGetWidth(source) == width,
           CVPixelBufferGetHeight(source) == height {
            return source
        }
        if nv12Buffer == nil || nv12Width != width || nv12Height != height || nv12Format != destFormat {
            var pb: CVPixelBuffer?
            let attrs: [String: Any] = [
                kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
            ]
            let status = CVPixelBufferCreate(
                kCFAllocatorDefault,
                width,
                height,
                destFormat,
                attrs as CFDictionary,
                &pb
            )
            guard status == kCVReturnSuccess, let pb else { return nil }
            nv12Buffer = pb
            nv12Width = width
            nv12Height = height
            nv12Format = destFormat
        }
        guard let dest = nv12Buffer else { return nil }
        if transfer == nil {
            var session: VTPixelTransferSession?
            guard VTPixelTransferSessionCreate(
                allocator: kCFAllocatorDefault,
                pixelTransferSessionOut: &session
            ) == noErr, let session else { return nil }
            transfer = session
        }
        guard let transfer,
              VTPixelTransferSessionTransferImage(transfer, from: source, to: dest) == noErr
        else { return nil }
        return dest
    }

    private func writeAll(_ data: Data) throws {
        guard fd >= 0 else { throw HostEncoderError.connect }
        var sent = 0
        try data.withUnsafeBytes { raw in
            let base = raw.bindMemory(to: UInt8.self).baseAddress!
            while sent < data.count {
                let n = Darwin.write(fd, base.advanced(by: sent), data.count - sent)
                if n <= 0 { throw HostEncoderError.connect }
                sent += n
            }
        }
    }

    private func readExact(_ count: Int) throws -> Data {
        guard fd >= 0 else { throw HostEncoderError.connect }
        var out = Data()
        out.reserveCapacity(count)
        var buf = [UInt8](repeating: 0, count: min(count, 64 * 1024))
        while out.count < count {
            let chunk = min(buf.count, count - out.count)
            let n = buf.withUnsafeMutableBufferPointer { Darwin.read(fd, $0.baseAddress, chunk) }
            if n <= 0 { throw HostEncoderError.connect }
            out.append(contentsOf: buf[0 ..< n])
        }
        return out
    }
}

private enum HostEncoderError: Error {
    case connect
    case proto
    case badFrame
}
