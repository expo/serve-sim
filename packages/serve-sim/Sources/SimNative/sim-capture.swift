import Foundation
import CoreVideo
import CoreMedia
import Accelerate

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
    let maxDimension: Int
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
    private var videoEncoder: VideoEncoder
    private let h264Encoder: H264Encoder
    private let encodeQueue = DispatchQueue(label: "napi.encode", qos: .userInteractive)
    private let h264Queue = DispatchQueue(label: "napi.encode.h264", qos: .userInteractive)
    private let framePreparationQueue = DispatchQueue(label: "napi.frame.prepare", qos: .userInteractive)
    private let framePreparationLock = NSLock()
    private static let h264EncodeTimeoutMs = 500

    // Mirrors main.swift's globals; mutated from the capture queue, read from the
    // encode queues. Benign races (same pattern as the standalone helper).
    private var screenWidth = 0
    private var screenHeight = 0
    private var encodeWidth = 0
    private var encodeHeight = 0
    private var encoderReady = false
    private var encoding = false       // MJPEG backpressure
    private var h264Encoding = false   // H.264 backpressure
    private var forceKeyframe = false
    private var mjpegActive = false
    private var avccActive = false
    private var h264FrameToken: UInt64 = 0
    private var h264ReservedCount: Int64 = 0
    private var h264SubmittedCount: Int64 = 0
    private var h264BackpressureSkips: Int64 = 0
    private var mjpegThrottleSkips: Int64 = 0
    private var h264ThrottleSkips: Int64 = 0
    private var webRTCReservedCount: Int64 = 0
    private var webRTCThrottleSkips: Int64 = 0
    private var webRTCDirectCount: Int64 = 0
    private var webRTCCopyFailures: Int64 = 0
    private var avccNativeEmitCount: Int64 = 0
    private var pixelBufferCopyCount: Int64 = 0
    private var scaledFramePreparationPending = false
    private let statsLock = NSLock()
    private let statsStartNs = DispatchTime.now().uptimeNanoseconds
    private var statsCaptureFrames: Int64 = 0
    private var statsLastCaptureAtNs: UInt64 = 0
    private var statsScaleCount: Int64 = 0
    private var statsScaleTotalMs = 0.0
    private var statsScaleLastMs = 0.0
    private var statsScaleMaxMs = 0.0
    private var statsScaleBackpressureSkips: Int64 = 0
    private var statsScaleInputWidth = 0
    private var statsScaleInputHeight = 0
    private var statsScaleOutputWidth = 0
    private var statsScaleOutputHeight = 0
    private var statsCopyCount: Int64 = 0
    private var statsCopyTotalMs = 0.0
    private var statsCopyLastMs = 0.0
    private var statsCopyMaxMs = 0.0
    private var statsCopyWidth = 0
    private var statsCopyHeight = 0
    private var statsMjpegReserved: Int64 = 0
    private var statsMjpegThrottleSkips: Int64 = 0
    private var statsH264Reserved: Int64 = 0
    private var statsH264ThrottleSkips: Int64 = 0
    private var statsH264BackpressureSkips: Int64 = 0
    private var statsWebRTCReserved: Int64 = 0
    private var statsWebRTCThrottleSkips: Int64 = 0
    private var statsWebRTCDirect: Int64 = 0
    private var statsWebRTCCopyFailures: Int64 = 0
    private var lastMjpegReservedAtNs: UInt64 = 0
    private var lastH264ReservedAtNs: UInt64 = 0
    private var lastWebRTCReservedAtNs: UInt64 = 0
    private var mjpegMinFrameIntervalNs: UInt64
    private var h264MinFrameIntervalNs: UInt64
    private var webRTCMinFrameIntervalNs: UInt64
    private var webRTCMaxFps: Int
    private var maxDimension: Int
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
        webRTCMinFrameIntervalNs = UInt64(1_000_000_000 / h264Fps)
        webRTCMaxFps = h264Fps
        maxDimension = max(0, options.maxDimension)
        webRTCPublisher.onInput = onWebRTCInput
        webRTCPublisher.onActiveChanged = { [weak self] active in
            guard let self else { return }
            self.lastWebRTCReservedAtNs = 0
            self.frameCapture.setIdleRefreshFps(active ? self.webRTCMaxFps : 5)
            streamLog("[webrtc] active=\(active) idleRefreshFps=\(active ? self.webRTCMaxFps : 5)")
        }
        webRTCPublisher.updateSettings(maxFps: h264Fps, bitrate: h264Bitrate)

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
        recordCapturedFrame()
        let encodeSize = encodedSize(width: w, height: h)

        let dimensionsChanged = w != screenWidth || h != screenHeight ||
            encodeSize.width != encodeWidth || encodeSize.height != encodeHeight
        if dimensionsChanged {
            screenWidth = w
            screenHeight = h
            encodeWidth = encodeSize.width
            encodeHeight = encodeSize.height
            if encoderReady {
                videoEncoder.stop()
                encoderReady = false
            }
        }
        if mjpegActive && !encoderReady {
            videoEncoder.setup(width: Int32(encodeSize.width), height: Int32(encodeSize.height), fps: 60) { [weak self] jpeg in
                self?.emit(codec: Self.codecMJPEG, data: jpeg, flags: 0)
            }
            encoderReady = true
        }

        let h264Request = reserveH264EncodeIfNeeded()
        let shouldSendWebRTC = reserveWebRTCFrameIfNeeded()
        let shouldEncodeJpeg = mjpegActive && encoderReady && !encoding && reserveMjpegEncodeIfNeeded()
        if !shouldEncodeJpeg && h264Request == nil && !shouldSendWebRTC { return }

        if shouldSendWebRTC && h264Request == nil && !shouldEncodeJpeg && encodeSize.width == w && encodeSize.height == h {
            webRTCDirectCount += 1
            recordWebRTCDirect()
            if streamShouldLog(webRTCDirectCount) {
                streamLog("[webrtc] send direct frame #\(webRTCDirectCount) \(w)x\(h)")
            }
            webRTCPublisher.sendFrameDirect(pixelBuffer, timestamp: timestamp)
            return
        }

        if encodeSize.width != w || encodeSize.height != h {
            guard reserveScaledFramePreparation() else {
                recordScaleBackpressureSkip()
                if shouldEncodeJpeg { lastMjpegReservedAtNs = 0 }
                if let h264Request {
                    finishH264Encode(token: h264Request.token, restoreKeyframe: h264Request.forceKeyframe)
                }
                return
            }
            if shouldEncodeJpeg { encoding = true }
            guard let stableSourceFrame = copyPixelBuffer(pixelBuffer) else {
                finishScaledFramePreparation()
                if shouldEncodeJpeg { encoding = false }
                handleStableFrameFailure(h264Request: h264Request, shouldSendWebRTC: shouldSendWebRTC)
                return
            }
            framePreparationQueue.async { [weak self] in
                guard let self else { return }
                defer { self.finishScaledFramePreparation() }
                guard let stableFrame = self.copyPixelBuffer(
                    stableSourceFrame,
                    targetWidth: encodeSize.width,
                    targetHeight: encodeSize.height
                ) else {
                    if shouldEncodeJpeg { self.encoding = false }
                    self.handleStableFrameFailure(h264Request: h264Request, shouldSendWebRTC: shouldSendWebRTC)
                    return
                }
                self.deliverStableFrame(
                    stableFrame,
                    timestamp: timestamp,
                    shouldSendWebRTC: shouldSendWebRTC,
                    shouldEncodeJpeg: shouldEncodeJpeg,
                    h264Request: h264Request
                )
            }
            return
        }

        guard let stableFrame = copyPixelBuffer(pixelBuffer, targetWidth: encodeSize.width, targetHeight: encodeSize.height) else {
            handleStableFrameFailure(h264Request: h264Request, shouldSendWebRTC: shouldSendWebRTC)
            return
        }
        if shouldEncodeJpeg { encoding = true }
        deliverStableFrame(
            stableFrame,
            timestamp: timestamp,
            shouldSendWebRTC: shouldSendWebRTC,
            shouldEncodeJpeg: shouldEncodeJpeg,
            h264Request: h264Request
        )
    }

    private func deliverStableFrame(
        _ stableFrame: CVPixelBuffer,
        timestamp: CMTime,
        shouldSendWebRTC: Bool,
        shouldEncodeJpeg: Bool,
        h264Request: (forceKeyframe: Bool, token: UInt64)?
    ) {
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

    private func handleStableFrameFailure(
        h264Request: (forceKeyframe: Bool, token: UInt64)?,
        shouldSendWebRTC: Bool
    ) {
        if let h264Request {
            streamLog("[stream:avcc] failed to prepare capture frame for H.264 token=\(h264Request.token)")
            finishH264Encode(token: h264Request.token, restoreKeyframe: h264Request.forceKeyframe)
        }
        if shouldSendWebRTC {
            webRTCCopyFailures += 1
            recordWebRTCCopyFailure()
            if streamShouldLog(webRTCCopyFailures) {
                streamLog("[webrtc] failed to prepare capture frame for WebRTC")
            }
        }
    }

    private func reserveMjpegEncodeIfNeeded() -> Bool {
        let now = DispatchTime.now().uptimeNanoseconds
        if lastMjpegReservedAtNs != 0 && now - lastMjpegReservedAtNs < mjpegMinFrameIntervalNs {
            mjpegThrottleSkips += 1
            recordMjpegThrottleSkip()
            if streamShouldLog(mjpegThrottleSkips) {
                streamLog("[stream:mjpeg] skip frame: fps throttle")
            }
            return false
        }
        lastMjpegReservedAtNs = now
        recordMjpegReserved()
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
        let startNs = DispatchTime.now().uptimeNanoseconds
        for row in 0..<rows {
            memcpy(dstAddr + row * dstStride, srcAddr + row * srcStride, copyBytes)
        }
        let durationMs = Double(DispatchTime.now().uptimeNanoseconds - startNs) / 1_000_000.0
        recordCopiedFrame(
            width: width,
            height: height,
            durationMs: durationMs
        )
        if streamShouldLog(statsCopyCount) {
            streamLog(
                "[stream] copied frame #\(statsCopyCount) \(width)x\(height) " +
                "ms=\(String(format: "%.2f", durationMs))"
            )
        }
        return dst
    }

    private func encodedSize(width: Int, height: Int) -> (width: Int, height: Int) {
        guard maxDimension > 0, max(width, height) > maxDimension else {
            return (width, height)
        }
        let scale = Double(maxDimension) / Double(max(width, height))
        return (evenDimension(width, scale: scale), evenDimension(height, scale: scale))
    }

    private func evenDimension(_ value: Int, scale: Double) -> Int {
        let scaled = max(2, Int((Double(value) * scale).rounded()))
        return scaled.isMultiple(of: 2) ? scaled : max(2, scaled - 1)
    }

    private func copyPixelBuffer(_ source: CVPixelBuffer, targetWidth: Int, targetHeight: Int) -> CVPixelBuffer? {
        let width = CVPixelBufferGetWidth(source)
        let height = CVPixelBufferGetHeight(source)
        if width == targetWidth && height == targetHeight {
            return copyPixelBuffer(source)
        }

        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: targetWidth,
            kCVPixelBufferHeightKey as String: targetHeight,
            kCVPixelBufferCGImageCompatibilityKey as String: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
        ]
        var out: CVPixelBuffer?
        guard CVPixelBufferCreate(
            kCFAllocatorDefault, targetWidth, targetHeight, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &out
        ) == kCVReturnSuccess, let dst = out else { return nil }

        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(dst, [])
        defer {
            CVPixelBufferUnlockBaseAddress(dst, [])
            CVPixelBufferUnlockBaseAddress(source, .readOnly)
        }
        guard let srcAddr = CVPixelBufferGetBaseAddress(source),
              let dstAddr = CVPixelBufferGetBaseAddress(dst) else { return nil }

        var src = vImage_Buffer(
            data: srcAddr,
            height: vImagePixelCount(height),
            width: vImagePixelCount(width),
            rowBytes: CVPixelBufferGetBytesPerRow(source)
        )
        var dest = vImage_Buffer(
            data: dstAddr,
            height: vImagePixelCount(targetHeight),
            width: vImagePixelCount(targetWidth),
            rowBytes: CVPixelBufferGetBytesPerRow(dst)
        )
        let startNs = DispatchTime.now().uptimeNanoseconds
        let status = vImageScale_ARGB8888(
            &src,
            &dest,
            nil,
            vImage_Flags(kvImageNoFlags)
        )
        guard status == kvImageNoError else { return nil }
        let durationMs = Double(DispatchTime.now().uptimeNanoseconds - startNs) / 1_000_000.0
        pixelBufferCopyCount += 1
        recordScaledFrame(
            inputWidth: width,
            inputHeight: height,
            outputWidth: targetWidth,
            outputHeight: targetHeight,
            durationMs: durationMs
        )
        if streamShouldLog(pixelBufferCopyCount) {
            streamLog(
                "[stream] scaled frame #\(pixelBufferCopyCount) \(width)x\(height)->\(targetWidth)x\(targetHeight) " +
                "ms=\(String(format: "%.2f", durationMs))"
            )
        }
        return dst
    }

    private func reserveH264EncodeIfNeeded() -> (forceKeyframe: Bool, token: UInt64)? {
        h264Queue.sync {
            guard avccActive else { return nil }
            let now = DispatchTime.now().uptimeNanoseconds
            if !forceKeyframe && lastH264ReservedAtNs != 0 && now - lastH264ReservedAtNs < h264MinFrameIntervalNs {
                h264ThrottleSkips += 1
                recordH264ThrottleSkip()
                if streamShouldLog(h264ThrottleSkips) {
                    streamLog("[stream:avcc] skip H.264 frame: fps throttle")
                }
                return nil
            }
            guard !h264Encoding else {
                h264BackpressureSkips += 1
                recordH264BackpressureSkip()
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
            recordH264Reserved()
            if streamShouldLog(h264ReservedCount) || force {
                streamLog("[stream:avcc] reserved H.264 frame #\(h264ReservedCount) token=\(token) forceKeyframe=\(force)")
            }
            return (forceKeyframe: force, token: token)
        }
    }

    private func reserveWebRTCFrameIfNeeded() -> Bool {
        guard webRTCPublisher.isActive else { return false }
        let now = DispatchTime.now().uptimeNanoseconds
        if lastWebRTCReservedAtNs != 0 && now - lastWebRTCReservedAtNs < webRTCMinFrameIntervalNs {
            webRTCThrottleSkips += 1
            recordWebRTCThrottleSkip()
            if streamShouldLog(webRTCThrottleSkips) {
                streamLog("[webrtc] skip frame: fps throttle")
            }
            return false
        }
        lastWebRTCReservedAtNs = now
        webRTCReservedCount += 1
        recordWebRTCReserved()
        if streamShouldLog(webRTCReservedCount) {
            streamLog("[webrtc] reserved frame #\(webRTCReservedCount)")
        }
        return true
    }

    func statsJson() -> String {
        let nowNs = DispatchTime.now().uptimeNanoseconds
        let uptimeSec = max(0.001, Double(nowNs - statsStartNs) / 1_000_000_000.0)
        let captureStats: [String: Any]
        let scaleStats: [String: Any]
        let copyStats: [String: Any]
        let mjpegStats: [String: Any]
        let h264Stats: [String: Any]
        let webRTCStats: [String: Any]
        statsLock.lock()
        captureStats = [
            "frames": statsCaptureFrames,
            "avgFps": Double(statsCaptureFrames) / uptimeSec,
            "lastFrameAgeMs": statsLastCaptureAtNs == 0 ? -1.0 : Double(nowNs - statsLastCaptureAtNs) / 1_000_000.0,
            "screenWidth": screenWidth,
            "screenHeight": screenHeight,
            "encodeWidth": encodeWidth,
            "encodeHeight": encodeHeight,
        ]
        scaleStats = [
            "frames": statsScaleCount,
            "avgFps": Double(statsScaleCount) / uptimeSec,
            "inputWidth": statsScaleInputWidth,
            "inputHeight": statsScaleInputHeight,
            "outputWidth": statsScaleOutputWidth,
            "outputHeight": statsScaleOutputHeight,
            "msLast": statsScaleLastMs,
            "msAvg": statsScaleCount > 0 ? statsScaleTotalMs / Double(statsScaleCount) : 0.0,
            "msMax": statsScaleMaxMs,
            "backpressureSkips": statsScaleBackpressureSkips,
        ]
        copyStats = [
            "frames": statsCopyCount,
            "avgFps": Double(statsCopyCount) / uptimeSec,
            "width": statsCopyWidth,
            "height": statsCopyHeight,
            "msLast": statsCopyLastMs,
            "msAvg": statsCopyCount > 0 ? statsCopyTotalMs / Double(statsCopyCount) : 0.0,
            "msMax": statsCopyMaxMs,
        ]
        mjpegStats = [
            "reserved": statsMjpegReserved,
            "reservedAvgFps": Double(statsMjpegReserved) / uptimeSec,
            "throttleSkips": statsMjpegThrottleSkips,
            "active": mjpegActive,
        ]
        h264Stats = [
            "reserved": statsH264Reserved,
            "reservedAvgFps": Double(statsH264Reserved) / uptimeSec,
            "throttleSkips": statsH264ThrottleSkips,
            "backpressureSkips": statsH264BackpressureSkips,
            "active": avccActive,
        ]
        webRTCStats = [
            "reserved": statsWebRTCReserved,
            "reservedAvgFps": Double(statsWebRTCReserved) / uptimeSec,
            "throttleSkips": statsWebRTCThrottleSkips,
            "direct": statsWebRTCDirect,
            "copyFailures": statsWebRTCCopyFailures,
            "minFrameIntervalNs": webRTCMinFrameIntervalNs,
            "maxFps": webRTCMaxFps,
            "publisher": webRTCPublisher.statsSnapshot(nowNs: nowNs),
        ]
        statsLock.unlock()

        let payload: [String: Any] = [
            "uptimeMs": Double(nowNs - statsStartNs) / 1_000_000.0,
            "maxDimension": maxDimension,
            "capture": captureStats,
            "scale": scaleStats,
            "copy": copyStats,
            "mjpeg": mjpegStats,
            "h264": h264Stats,
            "webrtc": webRTCStats,
        ]
        guard
            JSONSerialization.isValidJSONObject(payload),
            let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        else {
            return "{\"error\":\"stream_stats_unavailable\"}"
        }
        return String(decoding: data, as: UTF8.self)
    }

    private func withStatsLock(_ body: () -> Void) {
        statsLock.lock()
        body()
        statsLock.unlock()
    }

    private func reserveScaledFramePreparation() -> Bool {
        framePreparationLock.lock()
        defer { framePreparationLock.unlock() }
        if scaledFramePreparationPending { return false }
        scaledFramePreparationPending = true
        return true
    }

    private func finishScaledFramePreparation() {
        framePreparationLock.lock()
        scaledFramePreparationPending = false
        framePreparationLock.unlock()
    }

    private func recordCapturedFrame() {
        let nowNs = DispatchTime.now().uptimeNanoseconds
        withStatsLock {
            statsCaptureFrames += 1
            statsLastCaptureAtNs = nowNs
        }
    }

    private func recordScaledFrame(
        inputWidth: Int,
        inputHeight: Int,
        outputWidth: Int,
        outputHeight: Int,
        durationMs: Double
    ) {
        withStatsLock {
            statsScaleCount += 1
            statsScaleTotalMs += durationMs
            statsScaleLastMs = durationMs
            statsScaleMaxMs = max(statsScaleMaxMs, durationMs)
            statsScaleInputWidth = inputWidth
            statsScaleInputHeight = inputHeight
            statsScaleOutputWidth = outputWidth
            statsScaleOutputHeight = outputHeight
        }
    }

    private func recordScaleBackpressureSkip() {
        withStatsLock { statsScaleBackpressureSkips += 1 }
    }

    private func recordCopiedFrame(width: Int, height: Int, durationMs: Double) {
        withStatsLock {
            statsCopyCount += 1
            statsCopyTotalMs += durationMs
            statsCopyLastMs = durationMs
            statsCopyMaxMs = max(statsCopyMaxMs, durationMs)
            statsCopyWidth = width
            statsCopyHeight = height
        }
    }

    private func recordMjpegReserved() {
        withStatsLock { statsMjpegReserved += 1 }
    }

    private func recordMjpegThrottleSkip() {
        withStatsLock { statsMjpegThrottleSkips += 1 }
    }

    private func recordH264Reserved() {
        withStatsLock { statsH264Reserved += 1 }
    }

    private func recordH264ThrottleSkip() {
        withStatsLock { statsH264ThrottleSkips += 1 }
    }

    private func recordH264BackpressureSkip() {
        withStatsLock { statsH264BackpressureSkips += 1 }
    }

    private func recordWebRTCReserved() {
        withStatsLock { statsWebRTCReserved += 1 }
    }

    private func recordWebRTCThrottleSkip() {
        withStatsLock { statsWebRTCThrottleSkips += 1 }
    }

    private func recordWebRTCDirect() {
        withStatsLock { statsWebRTCDirect += 1 }
    }

    private func recordWebRTCCopyFailure() {
        withStatsLock { statsWebRTCCopyFailures += 1 }
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

    func setMjpegActive(_ active: Bool) {
        encodeQueue.async { [weak self] in
            guard let self else { return }
            if active != self.mjpegActive {
                streamLog("[stream:mjpeg] active=\(active)")
            }
            self.mjpegActive = active
            if active {
                self.lastMjpegReservedAtNs = 0
            }
        }
    }

    func requestKeyframe() {
        h264Queue.async { [weak self] in
            self?.forceKeyframe = true
            streamLog("[stream:avcc] keyframe requested")
        }
    }

    func updateSettings(mjpegFps: Int, mjpegQuality: Double, h264Fps: Int, h264Bitrate: Int, maxDimension: Int) {
        let normalizedMjpegFps = max(1, mjpegFps)
        let normalizedQuality = CGFloat(min(max(mjpegQuality, 0.0), 1.0))
        let normalizedH264Fps = max(1, h264Fps)
        let normalizedBitrate = max(1, h264Bitrate)
        let normalizedMaxDimension = max(0, maxDimension)

        encodeQueue.sync {
            self.mjpegMinFrameIntervalNs = UInt64(1_000_000_000 / normalizedMjpegFps)
            self.maxDimension = normalizedMaxDimension
            self.videoEncoder.stop()
            self.videoEncoder = VideoEncoder(quality: normalizedQuality)
            self.encoderReady = false
            self.encoding = false
            self.lastMjpegReservedAtNs = 0
        }
        h264Queue.sync {
            self.h264MinFrameIntervalNs = UInt64(1_000_000_000 / normalizedH264Fps)
            self.webRTCMinFrameIntervalNs = UInt64(1_000_000_000 / normalizedH264Fps)
            self.webRTCMaxFps = normalizedH264Fps
            self.h264Encoder.update(fps: normalizedH264Fps, bitrate: normalizedBitrate)
            self.webRTCPublisher.updateSettings(maxFps: normalizedH264Fps, bitrate: normalizedBitrate)
            if self.webRTCPublisher.isActive {
                self.frameCapture.setIdleRefreshFps(normalizedH264Fps)
            }
            self.forceKeyframe = true
            self.h264Encoding = false
            self.lastH264ReservedAtNs = 0
            self.lastWebRTCReservedAtNs = 0
        }
        streamLog(
            "[stream] settings updated mjpegFps=\(normalizedMjpegFps) mjpegQuality=\(normalizedQuality) " +
            "h264Fps=\(normalizedH264Fps) h264Bitrate=\(normalizedBitrate) maxDimension=\(normalizedMaxDimension)"
        )
    }

    func handleWebRTCOffer(_ offerJson: String) throws -> String {
        let request = try JSONDecoder().decode(WebRTCOfferPayload.self, from: Data(offerJson.utf8))
        let answer = try webRTCPublisher.handleOffer(request)
        lastWebRTCReservedAtNs = 0
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
