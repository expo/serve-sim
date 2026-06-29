import Foundation
import CoreVideo
import CoreMedia

// The capture + encode engine, reused verbatim from SimStreamHelper. Replicates
// main.swift's frameHandler: MJPEG always encodes while clients exist; H.264 runs
// only while AVCC is active. Encoded bytes (JPEG, or natively-framed AVCC
// envelopes) are handed back through a Swift closure on a native encode thread;
// the node-swift binding (sim-module.swift) marshals them onto the JS thread via
// a NodeAsyncQueue (threadsafe function).

/// (codec, data, width, height, flags) -> Void, invoked on a native encode
/// thread. codec: 0 = MJPEG, 1 = AVCC. flags (AVCC): bit0 = description,
/// bit1 = keyframe. `data` is a freshly-copied value safe to retain.
typealias SimFrameCallback = (Int32, Data, Int32, Int32, Int32) -> Void
typealias SimInputCallback = (Data) -> Void

struct CaptureEngineOptions {
    let mjpegFps: Int
    let mjpegQuality: Double
    let h264Fps: Int
    let h264Bitrate: Int
}

final class CaptureEngine {
    static let codecMJPEG: Int32 = 0
    static let codecAVCC: Int32 = 1
    static let flagDescription: Int32 = 1 << 0
    static let flagKeyframe: Int32 = 1 << 1

    private let deviceUDID: String
    private let onFrame: SimFrameCallback
    private let webRTCPublisher = WebRTCPublisher()

    private let frameCapture = FrameCapture()
    private let videoEncoder: VideoEncoder
    private let h264Encoder: H264Encoder
    private let encodeQueue = DispatchQueue(label: "napi.encode", qos: .userInteractive)
    private let h264Queue = DispatchQueue(label: "napi.encode.h264", qos: .userInteractive)
    private static let h264EncodeTimeoutMs = 500

    // Mirrors main.swift's globals; mutated from the capture queue, read from the
    // encode queues. Benign races (same pattern as the standalone helper).
    private var screenWidth = 0
    private var screenHeight = 0
    private var encoderReady = false
    private var encoding = false       // MJPEG backpressure
    private var h264Encoding = false   // H.264 backpressure
    private var forceKeyframe = false
    private var avccActive = false
    private var h264FrameToken: UInt64 = 0
    private var h264ReservedCount: Int64 = 0
    private var h264SubmittedCount: Int64 = 0
    private var h264BackpressureSkips: Int64 = 0
    private var mjpegThrottleSkips: Int64 = 0
    private var h264ThrottleSkips: Int64 = 0
    private var avccNativeEmitCount: Int64 = 0
    private var lastMjpegReservedAtNs: UInt64 = 0
    private var lastH264ReservedAtNs: UInt64 = 0
    private let mjpegMinFrameIntervalNs: UInt64
    private let h264MinFrameIntervalNs: UInt64
    private var started = false
    private var stopped = false

    init(
        deviceUDID: String,
        options: CaptureEngineOptions,
        onFrame: @escaping SimFrameCallback,
        onWebRTCInput: @escaping SimInputCallback
    ) {
        self.deviceUDID = deviceUDID
        self.onFrame = onFrame
        let mjpegFps = max(1, options.mjpegFps)
        let h264Fps = max(1, options.h264Fps)
        let h264Bitrate = max(1, options.h264Bitrate)
        videoEncoder = VideoEncoder(quality: CGFloat(min(max(options.mjpegQuality, 0.0), 1.0)))
        h264Encoder = H264Encoder(fps: h264Fps, bitrate: h264Bitrate)
        mjpegMinFrameIntervalNs = UInt64(1_000_000_000 / mjpegFps)
        h264MinFrameIntervalNs = UInt64(1_000_000_000 / h264Fps)
        webRTCPublisher.onInput = onWebRTCInput

        h264Encoder.onEncoded = { [weak self] encoded in
            guard let self else { return }
            self.avccNativeEmitCount += 1
            let emitCount = self.avccNativeEmitCount
            if let description = encoded.description {
                streamLog("[stream:avcc] native emit description bytes=\(description.count)")
                self.emit(codec: Self.codecAVCC,
                          data: AVCCEnvelope.description(avcc: description),
                          flags: Self.flagDescription)
            }
            switch encoded.kind {
            case .keyframe:
                streamLog("[stream:avcc] native emit keyframe bytes=\(encoded.avcc.count)")
                self.emit(codec: Self.codecAVCC, data: AVCCEnvelope.keyframe(avcc: encoded.avcc),
                          flags: Self.flagKeyframe)
            case .delta:
                if streamShouldLog(emitCount) {
                    streamLog("[stream:avcc] native emit delta #\(emitCount) bytes=\(encoded.avcc.count)")
                }
                self.emit(codec: Self.codecAVCC, data: AVCCEnvelope.delta(avcc: encoded.avcc), flags: 0)
            }
        }
    }

    /// Hand encoded bytes to the binding. Gated by `stopped` so no callback fires
    /// once teardown has begun.
    private func emit(codec: Int32, data: Data, flags: Int32) {
        if stopped { return }
        onFrame(codec, data, Int32(screenWidth), Int32(screenHeight), flags)
    }

    func start() throws {
        guard !started else { return }
        // Latch `started` only after capture actually begins: if start() throws
        // (e.g. device not booted), a later retry should still be allowed.
        try frameCapture.start(deviceUDID: deviceUDID) { [weak self] pixelBuffer, timestamp in
            self?.handleFrame(pixelBuffer, timestamp: timestamp)
        }
        started = true
    }

    private func handleFrame(_ pixelBuffer: CVPixelBuffer, timestamp: CMTime) {
        let w = CVPixelBufferGetWidth(pixelBuffer)
        let h = CVPixelBufferGetHeight(pixelBuffer)

        if !encoderReady || w != screenWidth || h != screenHeight {
            screenWidth = w
            screenHeight = h
            videoEncoder.stop()
            videoEncoder.setup(width: Int32(w), height: Int32(h), fps: 60) { [weak self] jpeg in
                self?.emit(codec: Self.codecMJPEG, data: jpeg, flags: 0)
            }
            encoderReady = true
        }

        let h264Request = reserveH264EncodeIfNeeded()
        let shouldSendWebRTC = webRTCPublisher.isActive
        let shouldEncodeJpeg = encoderReady && !encoding && reserveMjpegEncodeIfNeeded()
        if !shouldEncodeJpeg && h264Request == nil && !shouldSendWebRTC { return }

        guard let stableFrame = copyPixelBuffer(pixelBuffer) else {
            if let h264Request {
                streamLog("[stream:avcc] failed to copy capture frame for H.264 token=\(h264Request.token)")
                finishH264Encode(token: h264Request.token, restoreKeyframe: h264Request.forceKeyframe)
            }
            return
        }

        if shouldSendWebRTC {
            webRTCPublisher.sendFrame(stableFrame, timestamp: timestamp)
        }

        if shouldEncodeJpeg {
            encoding = true
            encodeQueue.async { [weak self] in
                guard let self else { return }
                self.videoEncoder.encode(pixelBuffer: stableFrame)
                self.encoding = false
            }
        }

        // H.264 runs only while a viewer wants AVCC, so an all-MJPEG session pays
        // no VideoToolbox cost.
        if let h264Request {
            h264Queue.async { [weak self] in
                guard let self else { return }
                self.h264SubmittedCount += 1
                let submitted = self.h264SubmittedCount
                if streamShouldLog(submitted) || h264Request.forceKeyframe {
                    streamLog(
                        "[stream:avcc] send frame to H264Encoder #\(submitted) token=\(h264Request.token) " +
                        "forceKeyframe=\(h264Request.forceKeyframe)"
                    )
                }
                self.h264Encoder.encode(stableFrame, forceKeyframe: h264Request.forceKeyframe) {
                    self.finishH264Encode(token: h264Request.token)
                }
                self.scheduleH264EncodeTimeout(token: h264Request.token)
            }
        }
    }

    private func reserveMjpegEncodeIfNeeded() -> Bool {
        let now = DispatchTime.now().uptimeNanoseconds
        if lastMjpegReservedAtNs != 0 && now - lastMjpegReservedAtNs < mjpegMinFrameIntervalNs {
            mjpegThrottleSkips += 1
            if streamShouldLog(mjpegThrottleSkips) {
                streamLog("[stream:mjpeg] skip frame: fps throttle")
            }
            return false
        }
        lastMjpegReservedAtNs = now
        return true
    }

    /// Copy the live Simulator IOSurface immediately on the capture queue. The
    /// encoders run later and SimulatorKit recycles/mutates that IOSurface in
    /// place, so passing the wrapper CVPixelBuffer across queues can encode a
    /// half-updated frame.
    private func copyPixelBuffer(_ source: CVPixelBuffer) -> CVPixelBuffer? {
        let width = CVPixelBufferGetWidth(source)
        let height = CVPixelBufferGetHeight(source)
        let pixelFormat = CVPixelBufferGetPixelFormatType(source)
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: pixelFormat,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferCGImageCompatibilityKey as String: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
        ]
        var out: CVPixelBuffer?
        guard CVPixelBufferCreate(
            kCFAllocatorDefault, width, height, pixelFormat, attrs as CFDictionary, &out
        ) == kCVReturnSuccess, let dst = out else { return nil }

        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(dst, [])
        defer {
            CVPixelBufferUnlockBaseAddress(dst, [])
            CVPixelBufferUnlockBaseAddress(source, .readOnly)
        }
        guard let srcAddr = CVPixelBufferGetBaseAddress(source),
              let dstAddr = CVPixelBufferGetBaseAddress(dst) else { return nil }
        let srcStride = CVPixelBufferGetBytesPerRow(source)
        let dstStride = CVPixelBufferGetBytesPerRow(dst)
        let rows = CVPixelBufferGetHeight(source)
        let copyBytes = min(srcStride, dstStride)
        for row in 0..<rows {
            memcpy(dstAddr + row * dstStride, srcAddr + row * srcStride, copyBytes)
        }
        return dst
    }

    private func reserveH264EncodeIfNeeded() -> (forceKeyframe: Bool, token: UInt64)? {
        h264Queue.sync {
            guard avccActive else { return nil }
            let now = DispatchTime.now().uptimeNanoseconds
            if !forceKeyframe && lastH264ReservedAtNs != 0 && now - lastH264ReservedAtNs < h264MinFrameIntervalNs {
                h264ThrottleSkips += 1
                if streamShouldLog(h264ThrottleSkips) {
                    streamLog("[stream:avcc] skip H.264 frame: fps throttle")
                }
                return nil
            }
            guard !h264Encoding else {
                h264BackpressureSkips += 1
                if streamShouldLog(h264BackpressureSkips) {
                    streamLog("[stream:avcc] skip H.264 frame: encode pending token=\(h264FrameToken)")
                }
                return nil
            }
            h264Encoding = true
            h264FrameToken &+= 1
            let token = h264FrameToken
            let force = forceKeyframe
            forceKeyframe = false
            lastH264ReservedAtNs = now
            h264ReservedCount += 1
            if streamShouldLog(h264ReservedCount) || force {
                streamLog("[stream:avcc] reserved H.264 frame #\(h264ReservedCount) token=\(token) forceKeyframe=\(force)")
            }
            return (forceKeyframe: force, token: token)
        }
    }

    private func finishH264Encode(token: UInt64, restoreKeyframe: Bool = false) {
        h264Queue.async { [weak self] in
            guard let self, self.h264FrameToken == token else { return }
            self.h264Encoding = false
            if restoreKeyframe { self.forceKeyframe = true }
        }
    }

    private func scheduleH264EncodeTimeout(token: UInt64) {
        h264Queue.asyncAfter(deadline: .now().advanced(by: .milliseconds(Self.h264EncodeTimeoutMs))) { [weak self] in
            guard let self, self.h264FrameToken == token, self.h264Encoding else { return }
            self.h264Encoding = false
            self.h264Encoder.handleEncodeTimeout()
            streamLog("[stream:avcc] H.264 encode timed out token=\(token)")
        }
    }

    /// Toggle H.264 encoding. Turning it on forces the next frame to an IDR so a
    /// freshly-connected decoder has a keyframe to start from.
    func setAvccActive(_ active: Bool) {
        h264Queue.async { [weak self] in
            guard let self else { return }
            if active && !self.avccActive { self.forceKeyframe = true }
            if active != self.avccActive {
                streamLog("[stream:avcc] active=\(active) forceKeyframe=\(self.forceKeyframe)")
            }
            self.avccActive = active
        }
    }

    func requestKeyframe() {
        h264Queue.async { [weak self] in
            self?.forceKeyframe = true
            streamLog("[stream:avcc] keyframe requested")
        }
    }

    func handleWebRTCOffer(_ offerJson: String) throws -> String {
        let request = try JSONDecoder().decode(WebRTCOfferPayload.self, from: Data(offerJson.utf8))
        let answer = try webRTCPublisher.handleOffer(request)
        let data = try JSONEncoder().encode(answer)
        return String(decoding: data, as: UTF8.self)
    }

    func screenSize() -> (Int, Int) { (screenWidth, screenHeight) }

    /// Halt frame production and drain the encode queues so no callback can fire
    /// after this returns — the N-API layer relies on that before releasing the
    /// threadsafe function.
    func stop() {
        if stopped { return }
        stopped = true
        frameCapture.stop()
        encodeQueue.sync {}
        h264Queue.sync {}
        webRTCPublisher.stop()
        videoEncoder.stop()
        h264Encoder.stop()
    }
}
