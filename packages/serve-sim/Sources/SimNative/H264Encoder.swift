import Foundation
import CoreVideo
import CoreMedia
import VideoToolbox

/// Real-time H.264 encoder backed by `VTCompressionSession`, producing AVCC
/// (length-prefixed NAL) output for the `/stream.avcc` endpoint.
///
/// Submission is fire-and-forget: the caller hands a `CVPixelBuffer` in and
/// the encoded chunk comes back via `onEncoded` on VideoToolbox's own queue.
/// The incoming buffer wraps SimulatorKit's live framebuffer IOSurface, which
/// SimulatorKit recycles in place — VT encodes asynchronously, so we deep-copy
/// into a private pooled buffer before submitting to avoid a torn frame race.
final class H264Encoder {
    struct Encoded {
        /// avcC parameter-set blob — emitted once on the first IDR per session.
        let description: Data?
        let kind: Kind
        /// Length-prefixed AVCC NAL bytes (not Annex-B start codes).
        let avcc: Data
        enum Kind { case keyframe, delta }
    }

    var onEncoded: ((Encoded) -> Void)?

    private let lock = NSLock()
    private var session: VTCompressionSession?
    private var pool: CVPixelBufferPool?
    private var width: Int32 = 0
    private var height: Int32 = 0
    private var fps: Int32
    private var bitrate: Int
    private let stateQueue = DispatchQueue(label: "H264Encoder.state")
    private var emittedDescription = false
    private var frameCount: Int64 = 0
    private var encodedCount: Int64 = 0
    private var lowLatencyEnabled = true
    private var forceKeyframeAfterReset = false
    private var retiredSessions: [VTCompressionSession] = []

    init(fps: Int = 60, bitrate: Int = 6_000_000) {
        self.fps = Int32(max(1, fps))
        self.bitrate = max(1, bitrate)
    }

    deinit {
        if let session { VTCompressionSessionInvalidate(session) }
        for session in retiredSessions { VTCompressionSessionInvalidate(session) }
    }

    /// Submit a frame. Returns immediately; `onEncoded` fires on VT's queue.
    func encode(_ source: CVPixelBuffer, forceKeyframe: Bool = false, completion: (() -> Void)? = nil) {
        lock.lock()
        let w = Int32(CVPixelBufferGetWidth(source))
        let h = Int32(CVPixelBufferGetHeight(source))
        if session == nil || w != width || h != height {
            width = w
            height = h
            rebuildSession()
        }
        guard let session else {
            streamLog("[stream:h264] drop frame: VTCompressionSession unavailable size=\(w)x\(h)")
            lock.unlock()
            completion?()
            return
        }
        guard let copy = copyBuffer(source) else {
            streamLog("[stream:h264] drop frame: failed to copy pixel buffer size=\(w)x\(h)")
            lock.unlock()
            completion?()
            return
        }

        frameCount += 1
        let submittedFrame = frameCount
        let pts = CMTime(value: frameCount, timescale: fps)
        let effectiveForceKeyframe = forceKeyframe || forceKeyframeAfterReset
        forceKeyframeAfterReset = false
        let frameProps: NSDictionary? = effectiveForceKeyframe
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as NSDictionary
            : nil
        if streamShouldLog(submittedFrame) || effectiveForceKeyframe {
            streamLog(
                "[stream:h264] submit frame #\(submittedFrame) size=\(w)x\(h) " +
                "forceKeyframe=\(effectiveForceKeyframe)"
            )
        }
        lock.unlock()

        let status = VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: copy,
            presentationTimeStamp: pts,
            duration: .invalid,
            frameProperties: frameProps,
            infoFlagsOut: nil
        ) { [weak self] status, _, sampleBuffer in
            defer { completion?() }
            guard let self else { return }
            guard status == noErr else {
                streamLog("[stream:h264] encode callback failed frame #\(submittedFrame) status=\(status)")
                self.fallbackFromLowLatency(reason: "callback status=\(status)")
                return
            }
            guard let sb = sampleBuffer else {
                streamLog("[stream:h264] encode callback missing sample frame #\(submittedFrame)")
                self.fallbackFromLowLatency(reason: "callback missing sample")
                return
            }
            guard let encoded = self.extract(from: sb) else {
                streamLog("[stream:h264] encode callback produced unextractable sample frame #\(submittedFrame)")
                return
            }
            let encodedFrame = self.nextEncodedCount()
            if streamShouldLog(encodedFrame) || encoded.description != nil || encoded.kind == .keyframe {
                let kind = encoded.kind == .keyframe ? "keyframe" : "delta"
                streamLog(
                    "[stream:h264] encoded #\(encodedFrame) kind=\(kind) bytes=\(encoded.avcc.count) " +
                    "descriptionBytes=\(encoded.description?.count ?? 0)"
                )
            }
            self.onEncoded?(encoded)
        }
        if status != noErr {
            streamLog("[stream:h264] VTCompressionSessionEncodeFrame failed frame #\(submittedFrame) status=\(status)")
            fallbackFromLowLatency(reason: "submit status=\(status)")
            completion?()
        }
    }

    func handleEncodeTimeout() {
        fallbackFromLowLatency(reason: "encode timeout")
    }

    func update(fps nextFps: Int, bitrate nextBitrate: Int) {
        lock.lock()
        defer { lock.unlock() }
        let normalizedFps = Int32(max(1, nextFps))
        let normalizedBitrate = max(1, nextBitrate)
        guard fps != normalizedFps || bitrate != normalizedBitrate else { return }
        fps = normalizedFps
        bitrate = normalizedBitrate
        forceKeyframeAfterReset = true
        frameCount = 0
        if let session {
            retiredSessions.append(session)
            self.session = nil
        }
        pool = nil
        stateQueue.sync {
            emittedDescription = false
            encodedCount = 0
        }
        streamLog("[stream:h264] settings updated fps=\(fps) bitrate=\(bitrate)")
    }

    func stop() {
        lock.lock()
        defer { lock.unlock() }
        if let session {
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }
        for session in retiredSessions { VTCompressionSessionInvalidate(session) }
        retiredSessions.removeAll()
        pool = nil
    }

    // MARK: - private

    /// Deep-copy `source` (which wraps the recycled framebuffer IOSurface)
    /// into a private pooled buffer that VT can hold past this call.
    private func copyBuffer(_ source: CVPixelBuffer) -> CVPixelBuffer? {
        guard let pool else { return nil }
        var out: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &out) == kCVReturnSuccess,
              let dst = out else { return nil }

        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(dst, [])
        defer {
            CVPixelBufferUnlockBaseAddress(dst, [])
            CVPixelBufferUnlockBaseAddress(source, .readOnly)
        }
        guard let src = CVPixelBufferGetBaseAddress(source),
              let dstAddr = CVPixelBufferGetBaseAddress(dst) else { return nil }
        let srcStride = CVPixelBufferGetBytesPerRow(source)
        let dstStride = CVPixelBufferGetBytesPerRow(dst)
        let rows = CVPixelBufferGetHeight(source)
        let copyBytes = min(srcStride, dstStride)
        for row in 0..<rows {
            memcpy(dstAddr + row * dstStride, src + row * srcStride, copyBytes)
        }
        return dst
    }

    private func rebuildSession() {
        if let session {
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }

        // Low-latency rate control puts VideoToolbox in its real-time/low-delay
        // pipeline and, crucially, emits a bitstream the *decoder* treats as
        // low-latency (small max_dec_frame_buffering). Without it the decoder
        // fills a large DPB before emitting, adding ~300ms of latency on the
        // client even though the stream carries no B-frames. Falls back to the
        // default spec on the rare hardware that rejects it.
        let lowLatencySpec: NSDictionary = [
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue!,
        ]
        var sess: VTCompressionSession?
        func create(spec: CFDictionary?) -> OSStatus {
            VTCompressionSessionCreate(
                allocator: kCFAllocatorDefault,
                width: width, height: height,
                codecType: kCMVideoCodecType_H264,
                encoderSpecification: spec,
                imageBufferAttributes: nil,
                compressedDataAllocator: kCFAllocatorDefault,
                outputCallback: nil,
                refcon: nil,
                compressionSessionOut: &sess
            )
        }
        let preferredSpec: CFDictionary?
        if lowLatencyEnabled {
            preferredSpec = lowLatencySpec
        } else {
            preferredSpec = nil
        }
        var status = create(spec: preferredSpec)
        if lowLatencyEnabled && (status != noErr || sess == nil) {
            streamLog("[stream:h264] low-latency VT session create failed status=\(status); retrying default")
            lowLatencyEnabled = false
            forceKeyframeAfterReset = true
            sess = nil
            status = create(spec: nil)
        }
        guard status == noErr, let sess else {
            streamLog("[stream:h264] VT session create failed status=\(status) size=\(width)x\(height)")
            return
        }

        let props: [(CFString, Any)] = [
            (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue!),
            (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel),
            (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanTrue!),
            (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate)),
            (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: fps)),
            // 5s keyframe interval: IDRs are far larger than P-frames, so
            // spacing them out keeps scroll/animation smooth. Late joiners
            // don't wait for the natural IDR — we force one on connect.
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: fps * 5)),
        ]
        for (key, value) in props {
            let propStatus = VTSessionSetProperty(sess, key: key, value: value as CFTypeRef)
            if propStatus != noErr {
                streamLog("[stream:h264] VTSessionSetProperty failed key=\(key) status=\(propStatus)")
            }
        }
        let prepareStatus = VTCompressionSessionPrepareToEncodeFrames(sess)
        if prepareStatus != noErr {
            streamLog("[stream:h264] VTCompressionSessionPrepareToEncodeFrames status=\(prepareStatus)")
        }
        session = sess
        stateQueue.sync {
            emittedDescription = false
            encodedCount = 0
        }

        // Pool feeding the deep-copy; BGRA matches the framebuffer surface.
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: Int(width),
            kCVPixelBufferHeightKey as String: Int(height),
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        var newPool: CVPixelBufferPool?
        let poolStatus = CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &newPool)
        if poolStatus != kCVReturnSuccess || newPool == nil {
            streamLog("[stream:h264] pixel buffer pool create failed status=\(poolStatus) size=\(width)x\(height)")
        } else {
            let mode = lowLatencyEnabled ? "low-latency" : "default"
            streamLog("[stream:h264] VT session ready mode=\(mode) size=\(width)x\(height) fps=\(fps) bitrate=\(bitrate)")
        }
        pool = newPool
    }

    private func fallbackFromLowLatency(reason: String) {
        lock.lock()
        defer { lock.unlock() }
        guard lowLatencyEnabled else { return }
        streamLog("[stream:h264] low-latency encoder failed (\(reason)); default VT session will be used")
        lowLatencyEnabled = false
        forceKeyframeAfterReset = true
        if let session {
            retiredSessions.append(session)
            self.session = nil
        }
        pool = nil
        stateQueue.sync {
            emittedDescription = false
            encodedCount = 0
        }
    }

    private func nextEncodedCount() -> Int64 {
        stateQueue.sync {
            encodedCount += 1
            return encodedCount
        }
    }

    private func extract(from sample: CMSampleBuffer) -> Encoded? {
        let isKeyframe = !notSync(sample)
        guard let dataBuf = CMSampleBufferGetDataBuffer(sample) else { return nil }

        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            dataBuf, atOffset: 0, lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength, dataPointerOut: &dataPointer
        ) == noErr, let dataPointer else { return nil }
        let avcc = Data(bytes: dataPointer, count: totalLength)

        var description: Data?
        if isKeyframe, let format = CMSampleBufferGetFormatDescription(sample) {
            let nextDescription = avcCBlob(from: format)
            let shouldEmit = stateQueue.sync { () -> Bool in
                if emittedDescription { return false }
                emittedDescription = nextDescription != nil
                return nextDescription != nil
            }
            if shouldEmit {
                description = nextDescription
            }
        }
        return Encoded(description: description, kind: isKeyframe ? .keyframe : .delta, avcc: avcc)
    }

    private func notSync(_ sample: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false),
              CFArrayGetCount(attachments) > 0,
              let dict = CFArrayGetValueAtIndex(attachments, 0) else { return false }
        let cfDict = unsafeBitCast(dict, to: CFDictionary.self)
        return CFDictionaryContainsKey(cfDict, Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque())
    }

    /// avcC parameter-set blob (ISO/IEC 14496-15 §5.2.4.1) carrying SPS + PPS.
    private func avcCBlob(from format: CMFormatDescription) -> Data? {
        var spsCount = 0
        var spsPtr: UnsafePointer<UInt8>?
        var spsSize = 0
        var nalSize: Int32 = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 0,
            parameterSetPointerOut: &spsPtr, parameterSetSizeOut: &spsSize,
            parameterSetCountOut: &spsCount, nalUnitHeaderLengthOut: &nalSize
        ) == noErr, let spsPtr, spsSize >= 4 else { return nil }

        var ppsPtr: UnsafePointer<UInt8>?
        var ppsSize = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 1,
            parameterSetPointerOut: &ppsPtr, parameterSetSizeOut: &ppsSize,
            parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil
        ) == noErr, let ppsPtr else { return nil }

        let sps = UnsafeBufferPointer(start: spsPtr, count: spsSize)
        let pps = UnsafeBufferPointer(start: ppsPtr, count: ppsSize)
        var blob = Data()
        blob.append(0x01)
        blob.append(sps[1]); blob.append(sps[2]); blob.append(sps[3])
        blob.append(0xFF)
        blob.append(0xE1)
        blob.append(UInt8((spsSize >> 8) & 0xFF)); blob.append(UInt8(spsSize & 0xFF))
        blob.append(contentsOf: sps)
        blob.append(0x01)
        blob.append(UInt8((ppsSize >> 8) & 0xFF)); blob.append(UInt8(ppsSize & 0xFF))
        blob.append(contentsOf: pps)
        return blob
    }
}
