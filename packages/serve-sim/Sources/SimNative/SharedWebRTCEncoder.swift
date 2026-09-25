import CoreMedia
import CoreVideo
import Foundation
import LiveKitWebRTC
import StreamingPolicy

private typealias EncoderCallback = (LKRTCEncodedImage, any LKRTCCodecSpecificInfo) -> Bool

final class SharedWebRTCEncoderFactory: NSObject, LKRTCVideoEncoderFactory {
    private let fallback = LKRTCDefaultVideoEncoderFactory()
    private let shared: SharedWebRTCEncoder
    private let h264Allowed: () -> Bool

    init(bitrate: Int, fps: Int, h264Allowed: @escaping () -> Bool) {
        shared = SharedWebRTCEncoder(bitrate: bitrate, fps: fps)
        self.h264Allowed = h264Allowed
    }

    func createEncoder(_ info: LKRTCVideoCodecInfo) -> (any LKRTCVideoEncoder)? {
        if info.name.caseInsensitiveCompare("H264") == .orderedSame, h264Allowed() {
            let mode: LKRTCH264PacketizationMode = info.parameters["packetization-mode"] == "0"
                ? .singleNalUnit : .nonInterleaved
            return shared.makeProxy(packetizationMode: mode)
        }
        return fallback.createEncoder(info)
    }

    func supportedCodecs() -> [LKRTCVideoCodecInfo] {
        fallback.supportedCodecs()
    }

    func requestIDR() {
        shared.requestIDR()
    }

    func updateFps(_ fps: Int) {
        shared.updateFps(fps)
    }

    func encodedFrameCount() -> UInt64 {
        shared.encodedFrameCount()
    }

    func stop() {
        shared.stop()
    }
}

private final class SharedWebRTCEncoder: @unchecked Sendable {
    private struct Pending {
        var peers: Set<Int>
        let rtpTimestamp: UInt32
        let captureTime: CMTime
        let width: Int32
        let height: Int32
    }

    private struct Completed {
        let encoded: H264Encoder.Encoded
        let annexB: Data
        let metadata: Pending
    }

    private struct QueuedFrame {
        let timestamp: Int64
        let buffer: CVPixelBuffer
        let forceIDR: Bool
        let bitrate: Int
    }

    private let queue = DispatchQueue(label: "webrtc-shared-h264", qos: .userInteractive)
    private let queueKey = DispatchSpecificKey<Bool>()
    private let encoder: H264Encoder
    private var policy: SharedH264Policy
    private var callbacks: [Int: (EncoderCallback, LKRTCH264PacketizationMode)] = [:]
    private var packetizationModes: [Int: LKRTCH264PacketizationMode] = [:]
    private var pending: [Int64: Pending] = [:]
    private var completed: [Int64: Completed] = [:]
    private var completedOrder: [Int64] = []
    private var nextPeer = 0
    private var backlog = SharedFrameBacklog()
    private var queuedFrame: QueuedFrame?
    private var stopped = false
    private var encodedFrames: UInt64 = 0
    private var fps: Int

    init(bitrate: Int, fps: Int) {
        self.fps = fps
        encoder = H264Encoder(fps: fps, bitrate: bitrate,
                              constrainedBaseline: true, dynamicBitrate: true)
        policy = SharedH264Policy(defaultBitrate: bitrate)
        queue.setSpecific(key: queueKey, value: true)
    }

    private func onQueue<T>(_ body: () -> T) -> T {
        if DispatchQueue.getSpecific(key: queueKey) != nil { return body() }
        return queue.sync(execute: body)
    }

    func makeProxy(packetizationMode: LKRTCH264PacketizationMode) -> SharedWebRTCEncoderProxy {
        onQueue {
            nextPeer += 1
            packetizationModes[nextPeer] = packetizationMode
            return SharedWebRTCEncoderProxy(id: nextPeer, shared: self)
        }
    }

    func requestIDR() {
        onQueue { policy.requestIDR() }
    }

    func updateFps(_ fps: Int) {
        onQueue { self.fps = fps }
    }

    func encodedFrameCount() -> UInt64 {
        onQueue { encodedFrames }
    }

    func start(peer: Int, settings: LKRTCVideoEncoderSettings) {
        onQueue {
            policy.join(peer: peer, bitrate: Int(settings.startBitrate) * 1_000)
        }
    }

    func release(peer: Int) {
        onQueue {
            callbacks.removeValue(forKey: peer)
            packetizationModes.removeValue(forKey: peer)
            policy.leave(peer: peer)
            for timestamp in pending.keys {
                pending[timestamp]?.peers.remove(peer)
            }
            discardUnusedFrames()
        }
    }

    func stop() {
        onQueue {
            callbacks.removeAll()
            packetizationModes.removeAll()
            queuedFrame = nil
            backlog.stop()
            pending.removeAll()
            completed.removeAll()
            completedOrder.removeAll()
            stopped = true
        }
    }

    private func discardUnusedFrames() {
        guard callbacks.isEmpty else { return }
        queuedFrame = nil
        backlog.discardQueued()
        pending.removeAll()
    }

    func setCallback(_ callback: EncoderCallback?, peer: Int) {
        onQueue {
            callbacks[peer] = callback.flatMap { value in
                packetizationModes[peer].map { (value, $0) }
            }
            if callback != nil { policy.requestIDR() }
        }
    }

    func setBitrate(_ bitrateKbit: UInt32, peer: Int) {
        onQueue { policy.setBitrate(Int(bitrateKbit) * 1_000, peer: peer) }
    }

    func encode(_ frame: LKRTCVideoFrame, peer: Int, frameTypes: [NSNumber]) -> Int {
        guard let buffer = (frame.buffer as? LKRTCCVPixelBuffer)?.pixelBuffer else { return -1 }
        return onQueue {
            guard !stopped else { return -1 }
            let timestamp = frame.timeStampNs
            let requestedIDR = frameTypes.contains { $0.intValue == LKRTCFrameType.videoFrameKey.rawValue }
            if let cached = completed[timestamp] {
                if requestedIDR, cached.encoded.kind != .keyframe { policy.requestIDR() }
                deliver(cached, to: peer)
                return 0
            }
            if pending[timestamp] != nil {
                if requestedIDR { policy.requestIDR() }
                pending[timestamp]?.peers.insert(peer)
                return 0
            }
            if queuedFrame?.forceIDR == true { policy.requestIDR() }
            guard let forceIDR = policy.beginFrame(timestamp: timestamp, requestedIDR: requestedIDR) else {
                return 0
            }
            let submission = backlog.submit(timestamp)
            if submission == .stale { return 0 }
            let metadata = Pending(
                peers: [peer], rtpTimestamp: UInt32(bitPattern: frame.timeStamp),
                captureTime: CMTime(value: timestamp, timescale: 1_000_000_000),
                width: Int32(frame.width), height: Int32(frame.height)
            )
            pending[timestamp] = metadata
            let next = QueuedFrame(timestamp: timestamp, buffer: buffer,
                                   forceIDR: forceIDR, bitrate: policy.bitrate)
            switch submission {
            case .start:
                startEncoding(next)
            case let .queued(replaced):
                if let replaced {
                    pending.removeValue(forKey: replaced)
                }
                queuedFrame = next
            case .stale:
                break
            }
            return 0
        }
    }

    private func startEncoding(_ frame: QueuedFrame) {
        let timestamp = frame.timestamp
        let fps = self.fps
        Task { [weak self] in
            guard let self, !Task.isCancelled else { return }
            await encoder.update(fps: fps, bitrate: frame.bitrate)
            let output = try? await encoder.encode(frame.buffer, forceKeyframe: frame.forceIDR)
            queue.async { self.complete(timestamp: timestamp, output: output) }
        }
    }

    private func complete(timestamp: Int64, output: H264Encoder.Encoded?) {
        guard backlog.encodingTimestamp == timestamp else { return }
        let nextTimestamp = backlog.complete(timestamp)
        defer {
            if let next = queuedFrame, next.timestamp == nextTimestamp {
                queuedFrame = nil
                startEncoding(next)
            }
        }
        guard let metadata = pending.removeValue(forKey: timestamp) else { return }
        guard let output, let annexB = H264AnnexB.convert(
            avcc: output.avcc, parameterSets: output.parameterSets,
            keyframe: output.kind == .keyframe
        ) else {
            policy.requestIDR()
            if let queuedFrame {
                self.queuedFrame = QueuedFrame(
                    timestamp: queuedFrame.timestamp, buffer: queuedFrame.buffer,
                    forceIDR: true, bitrate: queuedFrame.bitrate
                )
            }
            return
        }
        let packet = Completed(encoded: output, annexB: annexB, metadata: metadata)
        encodedFrames &+= 1
        completed[timestamp] = packet
        completedOrder.append(timestamp)
        if completedOrder.count > 8 {
            completed.removeValue(forKey: completedOrder.removeFirst())
        }
        for peer in metadata.peers {
            deliver(packet, to: peer)
        }
    }

    private func deliver(_ packet: Completed, to peer: Int) {
        guard let (callback, packetizationMode) = callbacks[peer] else { return }
        let image = LKRTCEncodedImage()
        image.buffer = packet.annexB
        image.encodedWidth = packet.metadata.width
        image.encodedHeight = packet.metadata.height
        image.timeStamp = packet.metadata.rtpTimestamp
        image.captureTimeMs = Int64(packet.metadata.captureTime.seconds * 1_000)
        image.frameType = packet.encoded.kind == .keyframe ? .videoFrameKey : .videoFrameDelta
        image.rotation = ._0
        let info = LKRTCCodecSpecificInfoH264()
        info.packetizationMode = packetizationMode
        _ = callback(image, info)
    }

}

private final class SharedWebRTCEncoderProxy: NSObject, LKRTCVideoEncoder {
    private let id: Int
    private let shared: SharedWebRTCEncoder

    init(id: Int, shared: SharedWebRTCEncoder) {
        self.id = id
        self.shared = shared
    }

    func setCallback(_ callback: EncoderCallback?) {
        shared.setCallback(callback, peer: id)
    }

    func startEncode(with settings: LKRTCVideoEncoderSettings, numberOfCores _: Int32) -> Int {
        shared.start(peer: id, settings: settings)
        return 0
    }

    func release() -> Int {
        shared.release(peer: id)
        return 0
    }

    func encode(_ frame: LKRTCVideoFrame, codecSpecificInfo _: (any LKRTCCodecSpecificInfo)?,
                frameTypes: [NSNumber]) -> Int {
        shared.encode(frame, peer: id, frameTypes: frameTypes)
    }

    func setBitrate(_ bitrateKbit: UInt32, framerate _: UInt32) -> Int32 {
        shared.setBitrate(bitrateKbit, peer: id)
        return 0
    }

    func implementationName() -> String { "serve-sim-shared-videotoolbox-h264" }

    func scalingSettings() -> LKRTCVideoEncoderQpThresholds? { nil }

    var resolutionAlignment: Int { 2 }
    var applyAlignmentToAllSimulcastLayers: Bool { true }
    var supportsNativeHandle: Bool { true }
}
