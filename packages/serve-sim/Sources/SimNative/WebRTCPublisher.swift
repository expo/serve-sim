import Foundation
import Darwin
import CoreVideo
import CoreMedia
import Accelerate
import VideoToolbox
import LiveKitWebRTC

struct WebRTCIceServerPayload: Codable {
    let urls: [String]
    let username: String?
    let credential: String?
}

struct WebRTCOfferPayload: Codable {
    let type: String
    let sdp: String
    let codec: String?
    let iceServers: [WebRTCIceServerPayload]?
}

struct WebRTCAnswerPayload: Codable {
    let type: String
    let sdp: String
}

final class WebRTCPublisher {
    var onInput: ((Data) -> Void)?
    var onActiveChanged: ((Bool) -> Void)?

    private let queue = DispatchQueue(label: "webrtc-publisher")
    private let factory: LKRTCPeerConnectionFactory
    private let videoSource: LKRTCVideoSource
    private let videoTrack: LKRTCVideoTrack
    private let capturer: LKRTCVideoCapturer
    private var session: WebRTCSession?
    private var lastOutputWidth = 0
    private var lastOutputHeight = 0
    private var sentFrameCount: Int64 = 0
    private var queuedInputFrameCount: Int64 = 0
    private var directInputFrameCount: Int64 = 0
    private var lastFrameTimestampNs: Int64 = 0
    private let statsStartNs = DispatchTime.now().uptimeNanoseconds
    private var lastFrameSentAtNs: UInt64 = 0
    private let usesCustomSoftwareH264Encoder: Bool
    private var totalI420Ms = 0.0
    private var lastI420Ms = 0.0
    private var maxI420Ms = 0.0
    private var lastInputPixelFormat: OSType?
    private var lastForwardedPixelFormat: OSType?
    private var lastFrameMode = "none"
    private var useNativePixelBufferFrames: Bool?
    private var requestedCodecName = "H264"
    private var selectedCodecName = "H264"
    private let h264PixelBufferConverter = H264WebRTCPixelBufferConverter()
    private let h264WebRTCSupport: WebRTCH264Support
    private let h264FrameModeOverride: H264WebRTCFrameMode?
    private var maxFps = 30
    private var targetBitrate = 6_000_000
    private var convertedFrameCount: Int64 = 0
    private var conversionFailureCount: Int64 = 0
    private var totalConversionMs = 0.0
    private var lastConversionMs = 0.0
    private var maxConversionMs = 0.0
    var isActive: Bool {
        queue.sync { session != nil }
    }

    init() {
        h264WebRTCSupport = Self.detectH264WebRTCSupport()
        h264FrameModeOverride = Self.h264FrameModeOverride()
        usesCustomSoftwareH264Encoder = h264WebRTCSupport.allowed && h264WebRTCSupport.usesHardware == false
        let defaultEncoderFactory = LKRTCDefaultVideoEncoderFactory()
        let encoderFactory: LKRTCVideoEncoderFactory = usesCustomSoftwareH264Encoder
            ? ServeSimSoftwareH264EncoderFactory(fallback: defaultEncoderFactory)
            : defaultEncoderFactory
        let decoderFactory = LKRTCDefaultVideoDecoderFactory()
        factory = LKRTCPeerConnectionFactory(
            encoderFactory: encoderFactory,
            decoderFactory: decoderFactory
        )
        videoSource = factory.videoSource(forScreenCast: true)
        videoTrack = factory.videoTrack(with: videoSource, trackId: "simulator-video")
        videoTrack.isEnabled = true
        capturer = LKRTCVideoCapturer(delegate: videoSource)
        let h264Status = h264WebRTCSupport.allowed
            ? "enabled(\(h264WebRTCSupport.probeSummary))"
            : "disabled(\(h264WebRTCSupport.reason ?? "unsupported runtime"))"
        let encoderFactoryStatus = usesCustomSoftwareH264Encoder ? "serve-sim H.264 encoder factory" : "default codec factory"
        print(
            "[webrtc] Publisher ready (\(encoderFactoryStatus) + screen-cast video source) " +
            "h264=\(h264Status) h264FrameMode=\(h264FrameModeDescription()) senderCodecs=\(senderCodecSummary())"
        )
    }

    func updateSettings(maxFps: Int, bitrate: Int) {
        let normalizedFps = max(1, min(120, maxFps))
        let normalizedBitrate = max(100_000, bitrate)
        queue.async {
            guard self.maxFps != normalizedFps || self.targetBitrate != normalizedBitrate else { return }
            self.maxFps = normalizedFps
            self.targetBitrate = normalizedBitrate
            if self.lastOutputWidth > 0, self.lastOutputHeight > 0 {
                self.videoSource.adaptOutputFormat(
                    toWidth: Int32(self.lastOutputWidth),
                    height: Int32(self.lastOutputHeight),
                    fps: Int32(self.maxFps)
                )
            }
            if let session = self.session {
                self.applyBitrateSettings(to: session)
            }
            print("[webrtc] Settings updated fps=\(normalizedFps) bitrate=\(normalizedBitrate)")
        }
    }

    func handleOffer(_ request: WebRTCOfferPayload) throws -> WebRTCAnswerPayload {
        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<WebRTCAnswerPayload, Error>?
        queue.async {
            self.createAnswer(request) { answerResult in
                result = answerResult
                semaphore.signal()
            }
        }
        semaphore.wait()
        return try result!.get()
    }

    func handleOffer(_ request: WebRTCOfferPayload) async throws -> WebRTCAnswerPayload {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                self.createAnswer(request) { result in
                    continuation.resume(with: result)
                }
            }
        }
    }

    func sendFrame(_ pixelBuffer: CVPixelBuffer, timestamp: CMTime) {
        queue.async {
            guard self.session != nil else { return }
            self.queuedInputFrameCount += 1
            self.sendFrameOnQueue(pixelBuffer, timestamp: timestamp, mode: "queued")
        }
    }

    func sendFrameDirect(_ pixelBuffer: CVPixelBuffer, timestamp: CMTime) {
        queue.sync {
            guard self.session != nil else { return }
            self.directInputFrameCount += 1
            self.sendFrameOnQueue(pixelBuffer, timestamp: timestamp, mode: "direct")
        }
    }

    func statsSnapshot(nowNs: UInt64 = DispatchTime.now().uptimeNanoseconds) -> [String: Any] {
        queue.sync {
            let uptimeSec = max(0.001, Double(nowNs - statsStartNs) / 1_000_000_000.0)
            let lastFrameAgeMs = lastFrameSentAtNs == 0 ? -1.0 : Double(nowNs - lastFrameSentAtNs) / 1_000_000.0
            var stats: [String: Any] = [
                "active": session != nil,
                "targetFps": maxFps,
                "targetBitrate": targetBitrate,
                "requestedCodec": requestedCodecName,
                "selectedCodec": selectedCodecName,
                "h264WebRTCEnabled": h264WebRTCSupport.allowed,
                "h264WebRTCProbe": h264WebRTCSupport.probeSummary,
                "h264WebRTCCustomEncoder": usesCustomSoftwareH264Encoder,
                "h264FrameMode": h264FrameModeDescription(),
                "frameMode": lastFrameMode,
                "outputWidth": lastOutputWidth,
                "outputHeight": lastOutputHeight,
                "sentFrames": sentFrameCount,
                "queuedInputFrames": queuedInputFrameCount,
                "directInputFrames": directInputFrameCount,
                "avgSentFps": Double(sentFrameCount) / uptimeSec,
                "lastFrameAgeMs": lastFrameAgeMs,
                "convertedFrames": convertedFrameCount,
                "conversionFailures": conversionFailureCount,
                "conversionMsLast": lastConversionMs,
                "conversionMsAvg": convertedFrameCount > 0 ? totalConversionMs / Double(convertedFrameCount) : 0.0,
                "conversionMsMax": maxConversionMs,
                "i420MsLast": lastI420Ms,
                "i420MsAvg": sentFrameCount > 0 ? totalI420Ms / Double(sentFrameCount) : 0.0,
                "i420MsMax": maxI420Ms,
            ]
            if let lastInputPixelFormat {
                stats["inputPixelFormat"] = pixelFormatDescription(lastInputPixelFormat)
            }
            if let lastForwardedPixelFormat {
                stats["forwardedPixelFormat"] = pixelFormatDescription(lastForwardedPixelFormat)
            }
            if let reason = h264WebRTCSupport.reason {
                stats["h264WebRTCDisabledReason"] = reason
            }
            if let encoderID = h264WebRTCSupport.encoderID {
                stats["h264VideoToolboxEncoderID"] = encoderID
            }
            if let usesHardware = h264WebRTCSupport.usesHardware {
                stats["h264VideoToolboxUsesHardware"] = usesHardware
            }
            if let session {
                stats["outboundRtp"] = session.delegate.outboundStatsSnapshot()
            }
            return stats
        }
    }

    private func nextFrameTimestampNs(_ timestamp: CMTime) -> Int64 {
        let captureTime = CMTimeGetSeconds(timestamp) * 1_000_000_000
        let proposedTimestamp = captureTime.isFinite && captureTime > 0
            ? Int64(captureTime)
            : Int64(DispatchTime.now().uptimeNanoseconds)
        let timestampNs = max(proposedTimestamp, lastFrameTimestampNs + 1)
        lastFrameTimestampNs = timestampNs
        return timestampNs
    }

    private func sendFrameOnQueue(_ pixelBuffer: CVPixelBuffer, timestamp: CMTime, mode: String) {
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        if width != lastOutputWidth || height != lastOutputHeight {
            lastOutputWidth = width
            lastOutputHeight = height
            videoSource.adaptOutputFormat(
                toWidth: Int32(width),
                height: Int32(height),
                fps: Int32(maxFps)
            )
            print("[webrtc] Video source output format: \(width)x\(height) @ \(maxFps)fps")
        }
        let pixelFormat = CVPixelBufferGetPixelFormatType(pixelBuffer)
        if lastInputPixelFormat != pixelFormat {
            lastInputPixelFormat = pixelFormat
            let supported = LKRTCCVPixelBuffer.supportedPixelFormats()
                .contains(NSNumber(value: UInt32(pixelFormat)))
            useNativePixelBufferFrames = supported
            let frameMode = supported ? "native CVPixelBuffer" : "I420 fallback"
            print("[webrtc] Input pixel format: \(pixelFormat) cvPixelBufferSupported=\(supported); forwarding as \(frameMode)")
        }
        let timeNs = nextFrameTimestampNs(timestamp)
        let sourceFrame = LKRTCVideoFrame(
            buffer: LKRTCCVPixelBuffer(pixelBuffer: pixelBuffer),
            rotation: ._0,
            timeStampNs: timeNs
        )
        var convertDurationMs = 0.0
        var usedFrame = sourceFrame
        var usedNativeFrame = useNativePixelBufferFrames ?? false
        var forwardedPixelFormat = pixelFormat
        var frameMode = usedNativeFrame ? "native" : "i420"

        if selectedCodecName == "H264" {
            switch h264FrameMode() {
            case .bgra:
                usedNativeFrame = useNativePixelBufferFrames ?? false
                if usedNativeFrame {
                    frameMode = "bgra-h264"
                } else {
                    let convertStartNs = DispatchTime.now().uptimeNanoseconds
                    usedFrame = sourceFrame.newI420()
                    convertDurationMs = Double(DispatchTime.now().uptimeNanoseconds - convertStartNs) / 1_000_000.0
                    frameMode = "i420-fallback"
                }
            case .i420:
                let convertStartNs = DispatchTime.now().uptimeNanoseconds
                usedFrame = sourceFrame.newI420()
                convertDurationMs = Double(DispatchTime.now().uptimeNanoseconds - convertStartNs) / 1_000_000.0
                usedNativeFrame = false
                frameMode = "i420-h264"
            case .nv12:
                if Self.isBiPlanar420(pixelFormat) {
                    usedNativeFrame = true
                    frameMode = "nv12-input"
                } else if let converted = h264PixelBufferConverter.convert(pixelBuffer) {
                    convertDurationMs = h264PixelBufferConverter.lastDurationMs
                    forwardedPixelFormat = CVPixelBufferGetPixelFormatType(converted)
                    usedFrame = LKRTCVideoFrame(
                        buffer: LKRTCCVPixelBuffer(pixelBuffer: converted),
                        rotation: ._0,
                        timeStampNs: timeNs
                    )
                    usedNativeFrame = true
                    frameMode = "nv12"
                } else {
                    conversionFailureCount += 1
                    let convertStartNs = DispatchTime.now().uptimeNanoseconds
                    usedFrame = sourceFrame.newI420()
                    convertDurationMs = Double(DispatchTime.now().uptimeNanoseconds - convertStartNs) / 1_000_000.0
                    usedNativeFrame = false
                    frameMode = "i420-fallback"
                }
            }
        } else if !usedNativeFrame {
            let convertStartNs = DispatchTime.now().uptimeNanoseconds
            usedFrame = sourceFrame.newI420()
            convertDurationMs = Double(DispatchTime.now().uptimeNanoseconds - convertStartNs) / 1_000_000.0
            frameMode = "i420-fallback"
        }

        videoSource.capturer(capturer, didCapture: usedFrame)
        if convertDurationMs > 0 {
            convertedFrameCount += 1
            totalConversionMs += convertDurationMs
            maxConversionMs = max(maxConversionMs, convertDurationMs)
        }
        sentFrameCount += 1
        lastFrameSentAtNs = DispatchTime.now().uptimeNanoseconds
        lastForwardedPixelFormat = forwardedPixelFormat
        lastFrameMode = frameMode
        lastConversionMs = convertDurationMs
        lastI420Ms = frameMode == "i420-fallback" ? convertDurationMs : 0.0
        totalI420Ms += lastI420Ms
        maxI420Ms = max(maxI420Ms, lastI420Ms)
        if shouldLogFrame(sentFrameCount) {
            print(
                "[webrtc] Sent video frame #\(sentFrameCount) mode=\(mode) codec=\(selectedCodecName) " +
                "size=\(width)x\(height) timestampNs=\(timeNs) frameMode=\(frameMode) " +
                "inputFormat=\(pixelFormatDescription(pixelFormat)) " +
                "forwardedFormat=\(pixelFormatDescription(forwardedPixelFormat)) " +
                "native=\(usedNativeFrame) conversionMs=\(String(format: "%.2f", convertDurationMs))"
            )
        }
    }

    func stop() {
        queue.sync {
            session?.close()
            session = nil
            onActiveChanged?(false)
        }
    }

    private func createAnswer(
        _ request: WebRTCOfferPayload,
        completion: @escaping (Result<WebRTCAnswerPayload, Error>) -> Void
    ) {
        let config = LKRTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.bundlePolicy = .maxBundle
        config.rtcpMuxPolicy = .require
        config.candidateNetworkPolicy = .all
        config.continualGatheringPolicy = .gatherOnce
        config.iceServers = iceServers(from: request.iceServers)
        config.iceTransportPolicy = .all
        print("[webrtc] ICE transport policy: all (TURN as fallback)")
        print("[webrtc] ICE servers: \(iceServerSummary(request.iceServers))")

        let constraints = LKRTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: ["DtlsSrtpKeyAgreement": "true"]
        )
        let delegate = WebRTCSessionDelegate(onInput: { [weak self] data in
            self?.onInput?(data)
        }, onClosed: { [weak self] peerConnection in
            self?.clearSession(peerConnection)
        })
        guard let peerConnection = factory.peerConnection(
            with: config,
            constraints: constraints,
            delegate: delegate
        ) else {
            completion(.failure(makeError("Failed to create peer connection")))
            return
        }

        let session = WebRTCSession(peerConnection: peerConnection, delegate: delegate)
        self.session?.close()
        self.session = session
        onActiveChanged?(true)

        let remoteDescription = LKRTCSessionDescription(type: .offer, sdp: request.sdp)
        peerConnection.setRemoteDescription(remoteDescription) { error in
            if let error {
                completion(.failure(error))
                return
            }
            self.attachVideoTrack(to: peerConnection, codec: request.codec)
            peerConnection.answer(for: constraints) { answer, error in
                if let error {
                    completion(.failure(error))
                    return
                }
                guard let answer else {
                    completion(.failure(self.makeError("answer creation returned nil")))
                    return
                }
                peerConnection.setLocalDescription(answer) { error in
                    if let error {
                        completion(.failure(error))
                        return
                    }
                    session.waitForIceGathering { completed in
                        let local = peerConnection.localDescription ?? answer
                        let gatheredCandidates = delegate.generatedCandidatesSnapshot()
                        let finalSdp = self.sdpWithGatheredCandidates(
                            local.sdp,
                            candidates: gatheredCandidates
                        )
                        var candidateCounts = self.iceCandidateCounts(in: finalSdp)
                        if candidateCounts.isEmpty {
                            candidateCounts = self.iceCandidateCounts(in: gatheredCandidates)
                        }
                        if !completed {
                            print("[webrtc] ICE gathering timed out; proceeding with candidates gathered so far: \(candidateCounts)")
                        } else if self.hasCredentialedTurnServer(request.iceServers), candidateCounts["relay", default: 0] == 0 {
                            print("[webrtc] WARNING: no relay ICE candidates gathered for credentialed TURN offer; counts=\(candidateCounts)")
                        } else {
                            print("[webrtc] ICE candidates gathered: \(candidateCounts)")
                        }
                        completion(.success(WebRTCAnswerPayload(
                            type: LKRTCSessionDescription.string(for: local.type),
                            sdp: finalSdp
                        )))
                    }
                }
            }
        }
    }

    private func attachVideoTrack(to peerConnection: LKRTCPeerConnection, codec: String?) {
        let transceiver = peerConnection.transceivers.first { $0.mediaType == .video }
            ?? createFallbackVideoTransceiver(on: peerConnection)
        guard let transceiver else {
            _ = peerConnection.add(videoTrack, streamIds: ["stream0"])
            print("[webrtc] Could not find or create video transceiver; fell back to addTrack")
            return
        }

        transceiver.sender.track = videoTrack
        transceiver.sender.streamIds = ["stream0"]
        var directionError: NSError?
        transceiver.setDirection(.sendOnly, error: &directionError)
        if let directionError {
            print("[webrtc] Failed to set video transceiver direction: \(directionError.localizedDescription)")
        }
        applyVideoCodecPreference(codec, to: transceiver)
        let session = self.session
        session?.videoSender = transceiver.sender
        if let session {
            applyBitrateSettings(to: session)
        }
    }

    private func createFallbackVideoTransceiver(on peerConnection: LKRTCPeerConnection) -> LKRTCRtpTransceiver? {
        let initOptions = LKRTCRtpTransceiverInit()
        initOptions.direction = .sendOnly
        initOptions.streamIds = ["stream0"]
        return peerConnection.addTransceiver(with: videoTrack, init: initOptions)
    }

    private func iceServers(from payload: [WebRTCIceServerPayload]?) -> [LKRTCIceServer] {
        let servers = payload ?? [
            WebRTCIceServerPayload(urls: ["stun:stun.l.google.com:19302"], username: nil, credential: nil),
            WebRTCIceServerPayload(urls: ["stun:stun1.l.google.com:19302"], username: nil, credential: nil),
        ]
        return servers.flatMap { server in
            server.urls.map { url in
                LKRTCIceServer(
                    urlStrings: [url],
                    username: server.username,
                    credential: server.credential
                )
            }
        }
    }

    private func hasCredentialedTurnServer(_ payload: [WebRTCIceServerPayload]?) -> Bool {
        (payload ?? []).contains { server in
            guard
                let username = server.username, !username.isEmpty,
                let credential = server.credential, !credential.isEmpty
            else {
                return false
            }
            return server.urls.contains { $0.lowercased().hasPrefix("turn:") || $0.lowercased().hasPrefix("turns:") }
        }
    }

    private func iceServerSummary(_ payload: [WebRTCIceServerPayload]?) -> String {
        let servers = payload ?? []
        let stunUrls = servers.flatMap { server in
            server.urls.filter { $0.lowercased().hasPrefix("stun:") }
        }.count
        let turnUrls = servers.flatMap { server in
            server.urls.filter { $0.lowercased().hasPrefix("turn:") || $0.lowercased().hasPrefix("turns:") }
        }.count
        let credentialedTurnServers = servers.filter { server in
            let hasCredentials = !(server.username ?? "").isEmpty && !(server.credential ?? "").isEmpty
            return hasCredentials && server.urls.contains {
                $0.lowercased().hasPrefix("turn:") || $0.lowercased().hasPrefix("turns:")
            }
        }.count
        return "servers=\(servers.count) stunUrls=\(stunUrls) turnUrls=\(turnUrls) credentialedTurnServers=\(credentialedTurnServers)"
    }

    private func iceCandidateCounts(in sdp: String) -> [String: Int] {
        var counts: [String: Int] = [:]
        for line in sdp.split(separator: "\n") {
            let trimmedLine = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmedLine.hasPrefix("a=candidate:") else { continue }
            let parts = trimmedLine.split(whereSeparator: { $0 == " " || $0 == "\t" })
            if let typeIndex = parts.firstIndex(of: "typ"), parts.indices.contains(parts.index(after: typeIndex)) {
                counts[String(parts[parts.index(after: typeIndex)]), default: 0] += 1
            } else {
                counts["unknown", default: 0] += 1
            }
        }
        return counts
    }

    private func iceCandidateCounts(in candidates: [LKRTCIceCandidate]) -> [String: Int] {
        var counts: [String: Int] = [:]
        for candidate in candidates {
            let candidateLine = candidate.sdp.hasPrefix("a=")
                ? candidate.sdp
                : "a=\(candidate.sdp)"
            let parts = candidateLine.split(whereSeparator: { $0 == " " || $0 == "\t" })
            if let typeIndex = parts.firstIndex(of: "typ"), parts.indices.contains(parts.index(after: typeIndex)) {
                counts[String(parts[parts.index(after: typeIndex)]), default: 0] += 1
            } else {
                counts["unknown", default: 0] += 1
            }
        }
        return counts
    }

    private func sdpWithGatheredCandidates(_ sdp: String, candidates: [LKRTCIceCandidate]) -> String {
        let newline = sdp.contains("\r\n") ? "\r\n" : "\n"
        var lines = sdp.components(separatedBy: newline)
        let hadTrailingNewline = lines.last == ""
        if hadTrailingNewline {
            lines.removeLast()
        }
        var existingCandidateLines = Set<String>()
        var sectionsNeedingEndMarker = Set<Int>()
        var currentSection = -1
        for line in lines {
            if line.hasPrefix("m=") {
                currentSection += 1
            } else if line.hasPrefix("a=candidate:"), currentSection >= 0 {
                existingCandidateLines.insert(line)
                sectionsNeedingEndMarker.insert(currentSection)
            }
        }
        var sectionCandidates: [Int: [String]] = [:]

        for candidate in candidates {
            let candidateLine = candidate.sdp.hasPrefix("a=")
                ? candidate.sdp
                : "a=\(candidate.sdp)"
            let sectionIndex = mediaSectionIndex(
                in: lines,
                sdpMid: candidate.sdpMid,
                sdpMLineIndex: candidate.sdpMLineIndex
            )
            sectionsNeedingEndMarker.insert(sectionIndex)
            guard !existingCandidateLines.contains(candidateLine) else { continue }
            existingCandidateLines.insert(candidateLine)
            sectionCandidates[sectionIndex, default: []].append(candidateLine)
        }

        for sectionIndex in sectionsNeedingEndMarker.sorted(by: >) {
            let sectionRange = mediaSectionRange(in: lines, sectionIndex: sectionIndex)
            let insertIndex = endOfCandidatesIndex(in: lines, range: sectionRange) ?? sectionRange.upperBound
            var insertedLines = sectionCandidates[sectionIndex] ?? []
            if endOfCandidatesIndex(in: lines, range: sectionRange) == nil {
                insertedLines.append("a=end-of-candidates")
            }
            guard !insertedLines.isEmpty else { continue }
            lines.insert(contentsOf: insertedLines, at: insertIndex)
        }

        let body = lines.joined(separator: newline)
        return hadTrailingNewline ? "\(body)\(newline)" : body
    }

    private func mediaSectionIndex(
        in lines: [String],
        sdpMid: String?,
        sdpMLineIndex: Int32
    ) -> Int {
        if let sdpMid {
            var currentSection = -1
            for line in lines {
                if line.hasPrefix("m=") {
                    currentSection += 1
                } else if line == "a=mid:\(sdpMid)", currentSection >= 0 {
                    return currentSection
                }
            }
        }
        let candidateIndex = Int(sdpMLineIndex)
        return candidateIndex >= 0 ? candidateIndex : 0
    }

    private func mediaSectionRange(in lines: [String], sectionIndex: Int) -> Range<Int> {
        var currentSection = -1
        var start = lines.count
        for (index, line) in lines.enumerated() where line.hasPrefix("m=") {
            currentSection += 1
            if currentSection == sectionIndex {
                start = index
            } else if currentSection > sectionIndex, start < lines.count {
                return start..<index
            }
        }
        if start < lines.count {
            return start..<lines.count
        }
        return lines.count..<lines.count
    }

    private func endOfCandidatesIndex(in lines: [String], range: Range<Int>) -> Int? {
        for index in range {
            if lines[index] == "a=end-of-candidates" {
                return index
            }
        }
        return nil
    }

    private func applyVideoCodecPreference(_ codec: String?, to transceiver: LKRTCRtpTransceiver) {
        let requestedName = Self.preferredVideoCodecName(codec)
        requestedCodecName = requestedName
        var preferredName = requestedName
        if requestedName == "H264", !h264WebRTCSupport.allowed {
            preferredName = "VP8"
            print(
                "[webrtc] H.264 requested but disabled (\(h264WebRTCSupport.reason ?? "unsupported runtime")); " +
                "preferring VP8"
            )
        }
        selectedCodecName = preferredName
        let capabilities = factory.rtpSenderCapabilities(forKind: "video")
        let usableCodecs = capabilities.codecs.filter { capability in
            h264WebRTCSupport.allowed || !Self.codecCapability(capability, matches: "H264")
        }
        let preferredCodecs = usableCodecs.filter {
            $0.name.caseInsensitiveCompare(preferredName) == .orderedSame ||
                $0.mimeType.caseInsensitiveCompare("video/\(preferredName)") == .orderedSame
        }
        guard !preferredCodecs.isEmpty else {
            print("[webrtc] No sender codec capability found for \(preferredName); using default order")
            return
        }
        let remainingCodecs = usableCodecs.filter { capability in
            !preferredCodecs.contains { $0 === capability }
        }
        let orderedCodecs = preferredCodecs + remainingCodecs
        transceiver.codecPreferences = orderedCodecs
        print("[webrtc] Preferred video codec: \(preferredName)")
    }

    private func applyBitrateSettings(to session: WebRTCSession) {
        guard let sender = session.videoSender else { return }
        let parameters = sender.parameters
        let encodings = parameters.encodings.isEmpty
            ? [LKRTCRtpEncodingParameters()]
            : parameters.encodings
        let maxBitrate = NSNumber(value: targetBitrate)
        let minBitrate = NSNumber(value: max(100_000, targetBitrate / 4))
        let fps = NSNumber(value: maxFps)
        for encoding in encodings {
            encoding.isActive = true
            encoding.maxBitrateBps = maxBitrate
            encoding.minBitrateBps = minBitrate
            encoding.maxFramerate = fps
        }
        parameters.encodings = encodings
        sender.parameters = parameters
        let bweUpdated = session.peerConnection.setBweMinBitrateBps(
            minBitrate,
            currentBitrateBps: maxBitrate,
            maxBitrateBps: maxBitrate
        )
        print(
            "[webrtc] Sender parameters fps=\(maxFps) minBitrate=\(minBitrate) " +
            "maxBitrate=\(maxBitrate) bweUpdated=\(bweUpdated)"
        )
    }

    private func clearSession(_ peerConnection: LKRTCPeerConnection?) {
        queue.async {
            guard let session = self.session, session.peerConnection === peerConnection else { return }
            session.close()
            self.session = nil
            self.onActiveChanged?(false)
            print("[webrtc] Peer connection closed; publisher inactive")
        }
    }

    private func senderCodecSummary() -> String {
        let names = factory.rtpSenderCapabilities(forKind: "video").codecs.map { capability in
            capability.mimeType.isEmpty ? capability.name : capability.mimeType
        }
        return names.joined(separator: ",")
    }

    private func makeError(_ message: String) -> Error {
        NSError(domain: "serve-sim.webrtc", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func shouldLogFrame(_ count: Int64) -> Bool {
        count <= 5 || count % 120 == 0
    }

    private static func preferredVideoCodecName(_ codec: String?) -> String {
        switch codec?.lowercased() {
        case "vp8":
            return "VP8"
        case "vp9":
            return "VP9"
        default:
            return "H264"
        }
    }

    private static func codecCapability(_ capability: LKRTCRtpCodecCapability, matches name: String) -> Bool {
        capability.name.caseInsensitiveCompare(name) == .orderedSame ||
            capability.mimeType.caseInsensitiveCompare("video/\(name)") == .orderedSame
    }

    private static func isBiPlanar420(_ pixelFormat: OSType) -> Bool {
        pixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange ||
            pixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    }

    private func h264FrameMode() -> H264WebRTCFrameMode {
        if let h264FrameModeOverride {
            return h264FrameModeOverride
        }
        return h264WebRTCSupport.usesHardware == false ? .bgra : .nv12
    }

    private func h264FrameModeDescription() -> String {
        let source = h264FrameModeOverride == nil ? "auto" : "env"
        return "\(h264FrameMode().rawValue)(\(source))"
    }

    private static func detectH264WebRTCSupport() -> WebRTCH264Support {
        let environment = ProcessInfo.processInfo.environment
        if envFlagEnabled(environment["SERVE_SIM_DISABLE_WEBRTC_H264"]) {
            return WebRTCH264Support(
                allowed: false,
                reason: "disabled by SERVE_SIM_DISABLE_WEBRTC_H264",
                encoderID: nil,
                usesHardware: nil,
                probeSummary: "disabled by environment"
            )
        }
        if envFlagEnabled(environment["SERVE_SIM_ALLOW_VM_H264_WEBRTC"]) ||
            envFlagEnabled(environment["SERVE_SIM_FORCE_WEBRTC_H264"]) {
            return WebRTCH264Support(
                allowed: true,
                reason: nil,
                encoderID: nil,
                usesHardware: nil,
                probeSummary: "forced by environment"
            )
        }
        let probe = probeVideoToolboxH264Encoder()
        if probe.encodedFrame {
            return WebRTCH264Support(
                allowed: true,
                reason: nil,
                encoderID: probe.encoderID,
                usesHardware: probe.usesHardware,
                probeSummary: probe.summary
            )
        }
        let modelPrefix = sysctlString("hw.model").map { " on \($0)" } ?? ""
        return WebRTCH264Support(
            allowed: false,
            reason: "VideoToolbox H.264 probe failed\(modelPrefix): \(probe.summary)",
            encoderID: probe.encoderID,
            usesHardware: probe.usesHardware,
            probeSummary: probe.summary
        )
    }

    private static func probeVideoToolboxH264Encoder() -> H264VideoToolboxProbe {
        let width: Int32 = 64
        let height: Int32 = 64
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
            kCVPixelBufferWidthKey as String: Int(width),
            kCVPixelBufferHeightKey as String: Int(height),
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        var session: VTCompressionSession?
        let createStatus = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: attrs as CFDictionary,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &session
        )
        guard createStatus == noErr, let session else {
            return H264VideoToolboxProbe(
                encodedFrame: false,
                encoderID: nil,
                usesHardware: nil,
                summary: "createStatus=\(createStatus)"
            )
        }
        defer { VTCompressionSessionInvalidate(session) }

        _ = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        _ = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
        _ = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        _ = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: 30))

        let prepareStatus = VTCompressionSessionPrepareToEncodeFrames(session)
        let encoderID = vtSessionStringProperty(session, key: kVTCompressionPropertyKey_EncoderID)
        let usesHardware = inferredHardwareAcceleration(
            encoderID: encoderID,
            reported: vtSessionBoolProperty(session, key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder)
        )
        guard prepareStatus == noErr else {
            return H264VideoToolboxProbe(
                encodedFrame: false,
                encoderID: encoderID,
                usesHardware: usesHardware,
                summary: "encoderID=\(encoderID ?? "unknown") prepareStatus=\(prepareStatus)"
            )
        }

        guard let pixelBuffer = makeH264ProbePixelBuffer(width: Int(width), height: Int(height)) else {
            return H264VideoToolboxProbe(
                encodedFrame: false,
                encoderID: encoderID,
                usesHardware: usesHardware,
                summary: "encoderID=\(encoderID ?? "unknown") pixelBufferAllocationFailed"
            )
        }
        let semaphore = DispatchSemaphore(value: 0)
        var callbackStatus: OSStatus?
        var producedSample = false
        let encodeStatus = VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: CMTime(value: 0, timescale: 30),
            duration: CMTime(value: 1, timescale: 30),
            frameProperties: nil,
            infoFlagsOut: nil
        ) { status, _, sampleBuffer in
            callbackStatus = status
            producedSample = status == noErr && sampleBuffer.map(CMSampleBufferDataIsReady) == true
            semaphore.signal()
        }
        let completeStatus = VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        let completed = semaphore.wait(timeout: .now() + .milliseconds(750)) == .success
        let encodedFrame = encodeStatus == noErr &&
            completeStatus == noErr &&
            completed &&
            callbackStatus == noErr &&
            producedSample
        let hardwareSummary = usesHardware.map { "hardware=\($0)" } ?? "hardware=unknown"
        return H264VideoToolboxProbe(
            encodedFrame: encodedFrame,
            encoderID: encoderID,
            usesHardware: usesHardware,
            summary: "encoderID=\(encoderID ?? "unknown") \(hardwareSummary) " +
                "encodeStatus=\(encodeStatus) completeStatus=\(completeStatus) " +
                "callbackStatus=\(callbackStatus.map(String.init) ?? "missing") " +
                "sample=\(producedSample)"
        )
    }

    private static func makeH264ProbePixelBuffer(width: Int, height: Int) -> CVPixelBuffer? {
        let attrs: [String: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        var pixelBuffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
            attrs as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pixelBuffer else { return nil }
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard
            let yAddress = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0),
            let cbCrAddress = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1)
        else {
            return nil
        }
        let yStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        let cbCrStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1)
        let yPointer = yAddress.assumingMemoryBound(to: UInt8.self)
        let cbCrPointer = cbCrAddress.assumingMemoryBound(to: UInt8.self)
        for row in 0..<height {
            let rowPointer = yPointer.advanced(by: row * yStride)
            for column in 0..<width {
                rowPointer[column] = UInt8((row + column) & 0xff)
            }
        }
        for row in 0..<(height / 2) {
            let rowPointer = cbCrPointer.advanced(by: row * cbCrStride)
            for column in stride(from: 0, to: width, by: 2) {
                rowPointer[column] = 128
                rowPointer[column + 1] = 128
            }
        }
        return pixelBuffer
    }

    private static func h264FrameModeOverride() -> H264WebRTCFrameMode? {
        guard let raw = ProcessInfo.processInfo.environment["SERVE_SIM_WEBRTC_H264_FRAME_MODE"]?.lowercased() else {
            return nil
        }
        switch raw {
        case "bgra", "native-bgra":
            return .bgra
        case "i420":
            return .i420
        case "nv12", "native", "cvpixelbuffer":
            return .nv12
        default:
            print("[webrtc] Ignoring invalid SERVE_SIM_WEBRTC_H264_FRAME_MODE=\(raw); expected bgra, i420, or nv12")
            return nil
        }
    }

    private static func vtSessionStringProperty(_ session: VTCompressionSession, key: CFString) -> String? {
        var value: CFTypeRef?
        let status = withUnsafeMutablePointer(to: &value) { pointer in
            VTSessionCopyProperty(session, key: key, allocator: kCFAllocatorDefault, valueOut: pointer)
        }
        guard status == noErr, let value else { return nil }
        return String(describing: value)
    }

    private static func vtSessionBoolProperty(_ session: VTCompressionSession, key: CFString) -> Bool? {
        var value: CFTypeRef?
        let status = withUnsafeMutablePointer(to: &value) { pointer in
            VTSessionCopyProperty(session, key: key, allocator: kCFAllocatorDefault, valueOut: pointer)
        }
        guard status == noErr, let value else { return nil }
        if CFGetTypeID(value) == CFBooleanGetTypeID() {
            return CFBooleanGetValue((value as! CFBoolean))
        }
        return (value as? NSNumber)?.boolValue
    }

    private static func inferredHardwareAcceleration(encoderID: String?, reported: Bool?) -> Bool? {
        if let reported { return reported }
        guard let encoderID else { return nil }
        let normalized = encoderID.lowercased()
        if normalized.contains("paravirtualized") || normalized.contains(".ave.") {
            return true
        }
        if normalized.contains("com.apple.videotoolbox.videoencoder.h264") {
            return false
        }
        return nil
    }

    private static func envFlagEnabled(_ value: String?) -> Bool {
        switch value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "1", "true", "yes", "on":
            return true
        default:
            return false
        }
    }

    private static func sysctlString(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 1 else { return nil }
        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return nil }
        return String(cString: buffer)
    }
}

private struct WebRTCH264Support {
    let allowed: Bool
    let reason: String?
    let encoderID: String?
    let usesHardware: Bool?
    let probeSummary: String
}

private struct H264VideoToolboxProbe {
    let encodedFrame: Bool
    let encoderID: String?
    let usesHardware: Bool?
    let summary: String
}

private enum H264WebRTCFrameMode: String {
    case bgra
    case i420
    case nv12
}

private final class ServeSimSoftwareH264EncoderFactory: NSObject, LKRTCVideoEncoderFactory {
    private let fallback: LKRTCVideoEncoderFactory

    init(fallback: LKRTCVideoEncoderFactory) {
        self.fallback = fallback
    }

    func createEncoder(_ info: LKRTCVideoCodecInfo) -> (any LKRTCVideoEncoder)? {
        if info.name.caseInsensitiveCompare("H264") == .orderedSame {
            guard Self.isServeSimH264Profile(info) else {
                streamLog("[webrtc:h264] rejecting unsupported H.264 profile parameters=\(info.parameters)")
                return nil
            }
            return ServeSimSoftwareH264Encoder(codecInfo: info)
        }
        return fallback.createEncoder(info)
    }

    func supportedCodecs() -> [LKRTCVideoCodecInfo] {
        fallback.supportedCodecs().filter(Self.isSupportedCodec)
    }

    func implementations() -> [LKRTCVideoCodecInfo] {
        (fallback.implementations?() ?? fallback.supportedCodecs()).filter(Self.isSupportedCodec)
    }

    func encoderSelector() -> (any LKRTCVideoEncoderSelector)? {
        fallback.encoderSelector?()
    }

    func queryCodecSupport(
        _ info: LKRTCVideoCodecInfo,
        scalabilityMode: String?
    ) -> LKRTCVideoEncoderCodecSupport {
        if let queryCodecSupport = fallback.queryCodecSupport {
            if Self.codecInfo(info, matches: "H264"), !Self.isServeSimH264Profile(info) {
                return LKRTCVideoEncoderCodecSupport(supported: false)
            }
            return queryCodecSupport(info, scalabilityMode)
        }
        return LKRTCVideoEncoderCodecSupport(supported: Self.isSupportedCodec(info))
    }

    private static func isSupportedCodec(_ info: LKRTCVideoCodecInfo) -> Bool {
        !codecInfo(info, matches: "H264") || isServeSimH264Profile(info)
    }

    private static func isServeSimH264Profile(_ info: LKRTCVideoCodecInfo) -> Bool {
        guard let profileLevelId = info.parameters["profile-level-id"]?.lowercased() else {
            return false
        }
        // H264Encoder configures VideoToolbox for High profile. Do not advertise
        // baseline/constrained-baseline variants, because browsers may negotiate
        // those and then reject the High-profile SPS/PPS the encoder emits.
        return profileLevelId.hasPrefix("64")
    }

    private static func codecInfo(_ info: LKRTCVideoCodecInfo, matches name: String) -> Bool {
        info.name.caseInsensitiveCompare(name) == .orderedSame
    }
}

private final class ServeSimSoftwareH264Encoder: NSObject, LKRTCVideoEncoder {
    private let encoder = H264Encoder()
    private var callback: RTCVideoEncoderCallback?
    private var parameterSets = Data()
    private var width: Int32 = 0
    private var height: Int32 = 0
    private var fps: UInt32 = 30
    private var bitrateKbit: UInt32 = 3_000
    private var encodedCount: Int64 = 0
    private let stateQueue = DispatchQueue(label: "serve-sim.webrtc.h264.encoder")

    init(codecInfo: LKRTCVideoCodecInfo) {
        super.init()
        streamLog("[webrtc:h264] using serve-sim software VideoToolbox encoder parameters=\(codecInfo.parameters)")
        encoder.onEncoded = { [weak self] encoded in
            self?.emit(encoded)
        }
    }

    func setCallback(_ callback: RTCVideoEncoderCallback?) {
        stateQueue.sync {
            self.callback = callback
        }
    }

    func startEncode(
        with settings: LKRTCVideoEncoderSettings,
        numberOfCores: Int32
    ) -> Int {
        stateQueue.sync {
            width = Int32(settings.width)
            height = Int32(settings.height)
            fps = max(1, settings.maxFramerate)
            bitrateKbit = max(1, settings.startBitrate)
            parameterSets.removeAll(keepingCapacity: true)
            encodedCount = 0
        }
        encoder.update(fps: Int(max(1, settings.maxFramerate)), bitrate: Int(max(1, settings.startBitrate)) * 1000)
        streamLog(
            "[webrtc:h264] start width=\(settings.width) height=\(settings.height) " +
            "fps=\(settings.maxFramerate) bitrateKbit=\(settings.startBitrate) cores=\(numberOfCores)"
        )
        return 0
    }

    func release() -> Int {
        encoder.stop()
        stateQueue.sync {
            callback = nil
            parameterSets.removeAll(keepingCapacity: false)
            encodedCount = 0
        }
        streamLog("[webrtc:h264] release")
        return 0
    }

    func encode(
        _ frame: LKRTCVideoFrame,
        codecSpecificInfo info: (any LKRTCCodecSpecificInfo)?,
        frameTypes: [NSNumber]
    ) -> Int {
        guard let pixelBuffer = pixelBuffer(from: frame) else {
            streamLog("[webrtc:h264] drop frame: unsupported frame buffer \(type(of: frame.buffer))")
            return -1
        }
        let forceKeyframe = frameTypes.contains { $0.intValue == LKRTCFrameType.videoFrameKey.rawValue }
        stateQueue.sync {
            width = Int32(frame.width)
            height = Int32(frame.height)
        }
        encoder.encode(pixelBuffer, forceKeyframe: forceKeyframe)
        return 0
    }

    func setBitrate(_ bitrateKbit: UInt32, framerate: UInt32) -> Int32 {
        let normalizedBitrateKbit = max(1, bitrateKbit)
        let normalizedFps = max(1, framerate)
        let shouldUpdateEncoder = stateQueue.sync { () -> Bool in
            let previousBitrateKbit = self.bitrateKbit
            self.bitrateKbit = normalizedBitrateKbit
            fps = normalizedFps
            let delta = abs(Int64(normalizedBitrateKbit) - Int64(previousBitrateKbit))
            return delta * 100 >= Int64(max(1, previousBitrateKbit)) * 25
        }
        if shouldUpdateEncoder {
            encoder.update(fps: Int(normalizedFps), bitrate: Int(normalizedBitrateKbit) * 1000)
            streamLog("[webrtc:h264] bitrate bitrateKbit=\(normalizedBitrateKbit) fps=\(normalizedFps)")
        }
        return 0
    }

    func implementationName() -> String {
        "serve-sim-videotoolbox-h264"
    }

    func scalingSettings() -> LKRTCVideoEncoderQpThresholds? {
        nil
    }

    var resolutionAlignment: Int {
        2
    }

    var applyAlignmentToAllSimulcastLayers: Bool {
        true
    }

    var supportsNativeHandle: Bool {
        true
    }

    private func pixelBuffer(from frame: LKRTCVideoFrame) -> CVPixelBuffer? {
        if let buffer = frame.buffer as? LKRTCCVPixelBuffer {
            return buffer.pixelBuffer
        }
        streamLog("[webrtc:h264] frame buffer is not CVPixelBuffer-backed: \(type(of: frame.buffer))")
        return nil
    }

    private func emit(_ encoded: H264Encoder.Encoded) {
        let imageAndInfo: (LKRTCEncodedImage, LKRTCCodecSpecificInfoH264, Int64)? = stateQueue.sync {
            if let description = encoded.description {
                parameterSets = annexBParameterSets(fromAvcC: description)
            }
            var annexB = Data()
            if encoded.kind == .keyframe {
                annexB.append(parameterSets)
            }
            appendAnnexBNals(fromAvcc: encoded.avcc, to: &annexB)
            guard !annexB.isEmpty else { return nil }

            encodedCount += 1
            let image = LKRTCEncodedImage()
            image.buffer = annexB
            image.encodedWidth = width
            image.encodedHeight = height
            image.timeStamp = UInt32(truncatingIfNeeded: encodedCount * 90_000 / Int64(max(1, fps)))
            image.captureTimeMs = Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000)
            image.ntpTimeMs = image.captureTimeMs
            image.frameType = encoded.kind == .keyframe ? .videoFrameKey : .videoFrameDelta
            image.rotation = ._0
            image.contentType = .screenshare

            let h264Info = LKRTCCodecSpecificInfoH264()
            h264Info.packetizationMode = .nonInterleaved
            return (image, h264Info, encodedCount)
        }
        guard let (image, h264Info, nextCount) = imageAndInfo else { return }
        let callback = stateQueue.sync { self.callback }
        guard let callback else { return }
        _ = callback(image, h264Info)
        if streamShouldLog(nextCount) || image.frameType == .videoFrameKey {
            let kind = image.frameType == .videoFrameKey ? "keyframe" : "delta"
            streamLog("[webrtc:h264] emitted \(kind) #\(nextCount) bytes=\(image.buffer.count)")
        }
    }

    private func annexBParameterSets(fromAvcC avcC: Data) -> Data {
        guard avcC.count >= 7 else { return Data() }
        var offset = 5
        let spsCount = Int(avcC[offset] & 0x1f)
        offset += 1
        var out = Data()
        for _ in 0..<spsCount {
            guard offset + 2 <= avcC.count else { return out }
            let length = (Int(avcC[offset]) << 8) | Int(avcC[offset + 1])
            offset += 2
            guard offset + length <= avcC.count else { return out }
            appendAnnexBStartCode(to: &out)
            out.append(avcC.subdata(in: offset..<(offset + length)))
            offset += length
        }
        guard offset < avcC.count else { return out }
        let ppsCount = Int(avcC[offset])
        offset += 1
        for _ in 0..<ppsCount {
            guard offset + 2 <= avcC.count else { return out }
            let length = (Int(avcC[offset]) << 8) | Int(avcC[offset + 1])
            offset += 2
            guard offset + length <= avcC.count else { return out }
            appendAnnexBStartCode(to: &out)
            out.append(avcC.subdata(in: offset..<(offset + length)))
            offset += length
        }
        return out
    }

    private func appendAnnexBNals(fromAvcc avcc: Data, to out: inout Data) {
        var offset = 0
        while offset + 4 <= avcc.count {
            let length =
                (Int(avcc[offset]) << 24) |
                (Int(avcc[offset + 1]) << 16) |
                (Int(avcc[offset + 2]) << 8) |
                Int(avcc[offset + 3])
            offset += 4
            guard length > 0, offset + length <= avcc.count else { return }
            appendAnnexBStartCode(to: &out)
            out.append(avcc.subdata(in: offset..<(offset + length)))
            offset += length
        }
    }

    private func appendAnnexBStartCode(to out: inout Data) {
        out.append(0)
        out.append(0)
        out.append(0)
        out.append(1)
    }
}

private final class H264WebRTCPixelBufferConverter {
    private var pool: CVPixelBufferPool?
    private var width = 0
    private var height = 0
    private var conversionInfo = vImage_ARGBToYpCbCr()
    private var conversionReady = false
    private(set) var lastDurationMs = 0.0

    init() {
        var pixelRange = vImage_YpCbCrPixelRange(
            Yp_bias: 0,
            CbCr_bias: 128,
            YpRangeMax: 255,
            CbCrRangeMax: 255,
            YpMax: 255,
            YpMin: 1,
            CbCrMax: 255,
            CbCrMin: 0
        )
        let status = vImageConvert_ARGBToYpCbCr_GenerateConversion(
            kvImage_ARGBToYpCbCrMatrix_ITU_R_709_2,
            &pixelRange,
            &conversionInfo,
            kvImageARGB8888,
            kvImage420Yp8_CbCr8,
            vImage_Flags(kvImageNoFlags)
        )
        conversionReady = status == kvImageNoError
        if !conversionReady {
            streamLog("[webrtc] H.264 NV12 conversion setup failed status=\(status)")
        }
    }

    func convert(_ source: CVPixelBuffer) -> CVPixelBuffer? {
        guard conversionReady else { return nil }
        let sourceFormat = CVPixelBufferGetPixelFormatType(source)
        guard sourceFormat == kCVPixelFormatType_32BGRA else {
            streamLog("[webrtc] H.264 NV12 conversion unsupported input format=\(pixelFormatDescription(sourceFormat))")
            return nil
        }
        let sourceWidth = CVPixelBufferGetWidth(source)
        let sourceHeight = CVPixelBufferGetHeight(source)
        guard sourceWidth > 1, sourceHeight > 1 else { return nil }
        guard let output = makePixelBuffer(width: sourceWidth, height: sourceHeight) else { return nil }

        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(output, [])
        defer {
            CVPixelBufferUnlockBaseAddress(output, [])
            CVPixelBufferUnlockBaseAddress(source, .readOnly)
        }
        guard
            let sourceAddress = CVPixelBufferGetBaseAddress(source),
            CVPixelBufferGetPlaneCount(output) >= 2,
            let yAddress = CVPixelBufferGetBaseAddressOfPlane(output, 0),
            let cbCrAddress = CVPixelBufferGetBaseAddressOfPlane(output, 1)
        else {
            return nil
        }

        var sourceBuffer = vImage_Buffer(
            data: sourceAddress,
            height: vImagePixelCount(sourceHeight),
            width: vImagePixelCount(sourceWidth),
            rowBytes: CVPixelBufferGetBytesPerRow(source)
        )
        var yBuffer = vImage_Buffer(
            data: yAddress,
            height: vImagePixelCount(CVPixelBufferGetHeightOfPlane(output, 0)),
            width: vImagePixelCount(CVPixelBufferGetWidthOfPlane(output, 0)),
            rowBytes: CVPixelBufferGetBytesPerRowOfPlane(output, 0)
        )
        var cbCrBuffer = vImage_Buffer(
            data: cbCrAddress,
            height: vImagePixelCount(CVPixelBufferGetHeightOfPlane(output, 1)),
            width: vImagePixelCount(CVPixelBufferGetWidthOfPlane(output, 1)),
            rowBytes: CVPixelBufferGetBytesPerRowOfPlane(output, 1)
        )
        var bgraPermuteMap: [UInt8] = [3, 2, 1, 0]
        let startNs = DispatchTime.now().uptimeNanoseconds
        let status = vImageConvert_ARGB8888To420Yp8_CbCr8(
            &sourceBuffer,
            &yBuffer,
            &cbCrBuffer,
            &conversionInfo,
            &bgraPermuteMap,
            vImage_Flags(kvImageNoFlags)
        )
        lastDurationMs = Double(DispatchTime.now().uptimeNanoseconds - startNs) / 1_000_000.0
        guard status == kvImageNoError else {
            streamLog("[webrtc] H.264 NV12 conversion failed status=\(status)")
            return nil
        }
        attachColorMetadata(to: output)
        return output
    }

    private func makePixelBuffer(width nextWidth: Int, height nextHeight: Int) -> CVPixelBuffer? {
        if pool == nil || width != nextWidth || height != nextHeight {
            width = nextWidth
            height = nextHeight
            let attrs: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
                kCVPixelBufferWidthKey as String: nextWidth,
                kCVPixelBufferHeightKey as String: nextHeight,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:],
                kCVPixelBufferMetalCompatibilityKey as String: true,
            ]
            var newPool: CVPixelBufferPool?
            let status = CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &newPool)
            guard status == kCVReturnSuccess, let newPool else {
                streamLog("[webrtc] H.264 NV12 pixel buffer pool create failed status=\(status) size=\(nextWidth)x\(nextHeight)")
                pool = nil
                return nil
            }
            pool = newPool
            streamLog("[webrtc] H.264 NV12 pixel buffer pool ready size=\(nextWidth)x\(nextHeight)")
        }
        guard let pool else { return nil }
        var output: CVPixelBuffer?
        let status = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &output)
        guard status == kCVReturnSuccess, let output else {
            streamLog("[webrtc] H.264 NV12 pixel buffer allocation failed status=\(status)")
            return nil
        }
        return output
    }

    private func attachColorMetadata(to pixelBuffer: CVPixelBuffer) {
        CVBufferSetAttachment(
            pixelBuffer,
            kCVImageBufferYCbCrMatrixKey,
            kCVImageBufferYCbCrMatrix_ITU_R_709_2,
            .shouldPropagate
        )
        CVBufferSetAttachment(
            pixelBuffer,
            kCVImageBufferColorPrimariesKey,
            kCVImageBufferColorPrimaries_ITU_R_709_2,
            .shouldPropagate
        )
        CVBufferSetAttachment(
            pixelBuffer,
            kCVImageBufferTransferFunctionKey,
            kCVImageBufferTransferFunction_sRGB,
            .shouldPropagate
        )
    }
}

private func pixelFormatDescription(_ pixelFormat: OSType) -> String {
    var value = pixelFormat.bigEndian
    let text = withUnsafeBytes(of: &value) { rawBuffer -> String in
        let bytes = rawBuffer.map { byte -> UInt8 in
            if byte >= 32 && byte <= 126 {
                return byte
            }
            return UInt8(ascii: ".")
        }
        return String(bytes: bytes, encoding: .ascii) ?? "\(pixelFormat)"
    }
    return "\(text)(\(pixelFormat))"
}

private final class WebRTCSession {
    let peerConnection: LKRTCPeerConnection
    let delegate: WebRTCSessionDelegate
    var videoSender: LKRTCRtpSender?
    private let iceGatheringTimeout: DispatchTimeInterval = .milliseconds(3_000)

    init(peerConnection: LKRTCPeerConnection, delegate: WebRTCSessionDelegate) {
        self.peerConnection = peerConnection
        self.delegate = delegate
    }

    func waitForIceGathering(_ completion: @escaping (Bool) -> Void) {
        let lock = NSLock()
        var finished = false
        let finish = { [weak delegate] (completed: Bool) in
            lock.lock()
            if finished {
                lock.unlock()
                return
            }
            finished = true
            delegate?.setIceGatheringCompleteHandler(nil)
            lock.unlock()
            completion(completed)
        }
        delegate.setIceGatheringCompleteHandler {
            finish(true)
        }
        if peerConnection.iceGatheringState == .complete {
            finish(true)
            return
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + iceGatheringTimeout) {
            finish(false)
        }
    }

    func close() {
        peerConnection.close()
    }
}

private final class WebRTCSessionDelegate: NSObject, LKRTCPeerConnectionDelegate, LKRTCDataChannelDelegate {
    private let onInput: (Data) -> Void
    private let onClosed: (LKRTCPeerConnection) -> Void
    private let iceGatheringCompleteHandlerLock = NSLock()
    private var iceGatheringCompleteHandler: (() -> Void)?
    private let candidatesLock = NSLock()
    private var generatedCandidates: [LKRTCIceCandidate] = []
    private var statsScheduled = false
    private let outboundStatsLock = NSLock()
    private var latestOutboundStatsLabel = "none"
    private var latestOutboundStatsAtNs: UInt64 = 0
    private var latestOutboundStats: [[String: Any]] = []
    // RTCDataChannel.delegate is weak; retain opened channels until close so input callbacks keep firing.
    private let retainedDataChannelsLock = NSLock()
    private var retainedDataChannels: [ObjectIdentifier: LKRTCDataChannel] = [:]

    init(onInput: @escaping (Data) -> Void, onClosed: @escaping (LKRTCPeerConnection) -> Void) {
        self.onInput = onInput
        self.onClosed = onClosed
    }

    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange stateChanged: LKRTCSignalingState) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didAdd stream: LKRTCMediaStream) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove stream: LKRTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: LKRTCPeerConnection) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceConnectionState) {
        print("[webrtc] ICE connection state: \(newState.rawValue)")
        if newState == .connected || newState == .completed {
            scheduleOutboundStats(peerConnection)
        } else if newState == .failed || newState == .closed {
            onClosed(peerConnection)
        }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCPeerConnectionState) {
        print("[webrtc] Peer connection state: \(newState.rawValue)")
        if newState == .failed || newState == .closed {
            onClosed(peerConnection)
        }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceGatheringState) {
        print("[webrtc] ICE gathering state: \(newState.rawValue)")
        if newState == .complete {
            let completion = consumeIceGatheringCompleteHandler()
            completion?()
        }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {
        candidatesLock.lock()
        generatedCandidates.append(candidate)
        candidatesLock.unlock()
        print("[webrtc] ICE candidate gathered: \(candidateSummary(candidate))")
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {}
    func peerConnection(
        _ peerConnection: LKRTCPeerConnection,
        didChangeLocalCandidate local: LKRTCIceCandidate,
        remoteCandidate remote: LKRTCIceCandidate,
        lastReceivedMs: Int32,
        changeReason: String
    ) {
        print("[webrtc] ICE selected pair: local=\(candidateSummary(local)) remote=\(candidateSummary(remote)) reason=\(changeReason) lastReceivedMs=\(lastReceivedMs)")
    }
    func peerConnection(
        _ peerConnection: LKRTCPeerConnection,
        didFailToGatherIceCandidate event: LKRTCIceCandidateErrorEvent
    ) {
        print("[webrtc] ICE candidate error: url=\(event.url) code=\(event.errorCode) text=\(event.errorText)")
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didOpen dataChannel: LKRTCDataChannel) {
        print("[webrtc] viewer opened data channel: \(dataChannel.label)")
        retainedDataChannelsLock.lock()
        defer { retainedDataChannelsLock.unlock() }
        retainedDataChannels[ObjectIdentifier(dataChannel)] = dataChannel
        dataChannel.delegate = self
    }

    func dataChannelDidChangeState(_ dataChannel: LKRTCDataChannel) {
        streamLog("[webrtc] data channel state label=\(dataChannel.label) state=\(dataChannel.readyState.rawValue)")
        if dataChannel.readyState == .closed {
            retainedDataChannelsLock.lock()
            defer { retainedDataChannelsLock.unlock() }
            retainedDataChannels.removeValue(forKey: ObjectIdentifier(dataChannel))
        }
    }

    func dataChannel(_ dataChannel: LKRTCDataChannel, didReceiveMessageWith buffer: LKRTCDataBuffer) {
        let data = Data(buffer.data)
        streamLog("[webrtc] received input data-channel bytes=\(data.count) binary=\(buffer.isBinary)")
        onInput(data)
    }

    func generatedCandidatesSnapshot() -> [LKRTCIceCandidate] {
        candidatesLock.lock()
        let candidates = generatedCandidates
        candidatesLock.unlock()
        return candidates
    }

    func setIceGatheringCompleteHandler(_ handler: (() -> Void)?) {
        iceGatheringCompleteHandlerLock.lock()
        iceGatheringCompleteHandler = handler
        iceGatheringCompleteHandlerLock.unlock()
    }

    private func consumeIceGatheringCompleteHandler() -> (() -> Void)? {
        iceGatheringCompleteHandlerLock.lock()
        let handler = iceGatheringCompleteHandler
        iceGatheringCompleteHandler = nil
        iceGatheringCompleteHandlerLock.unlock()
        return handler
    }

    private func candidateSummary(_ candidate: LKRTCIceCandidate) -> String {
        let parts = candidate.sdp.split(whereSeparator: { $0 == " " || $0 == "\t" })
        let protocolName = parts.indices.contains(2) ? String(parts[2]).lowercased() : "?"
        let address = parts.indices.contains(4) ? String(parts[4]) : "?"
        let port = parts.indices.contains(5) ? String(parts[5]) : "?"
        let type: String
        if let typeIndex = parts.firstIndex(of: "typ"), parts.indices.contains(parts.index(after: typeIndex)) {
            type = String(parts[parts.index(after: typeIndex)])
        } else {
            type = "unknown"
        }
        let server = candidate.serverUrl?.isEmpty == false ? " server=\(candidate.serverUrl!)" : ""
        return "type=\(type) protocol=\(protocolName) address=\(address) port=\(port)\(server)"
    }

    private func scheduleOutboundStats(_ peerConnection: LKRTCPeerConnection) {
        guard !statsScheduled else { return }
        statsScheduled = true
        logOutboundStats(peerConnection, label: "connected")
        for seconds in [2.0, 5.0, 10.0] {
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + seconds) { [weak self, weak peerConnection] in
                guard let self, let peerConnection else { return }
                self.logOutboundStats(peerConnection, label: "+\(Int(seconds))s")
            }
        }
        scheduleRecurringOutboundStats(peerConnection)
    }

    private func scheduleRecurringOutboundStats(_ peerConnection: LKRTCPeerConnection) {
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 10.0) { [weak self, weak peerConnection] in
            guard let self, let peerConnection else { return }
            if peerConnection.connectionState == .failed || peerConnection.connectionState == .closed {
                return
            }
            self.logOutboundStats(peerConnection, label: "periodic")
            self.scheduleRecurringOutboundStats(peerConnection)
        }
    }

    private func logOutboundStats(_ peerConnection: LKRTCPeerConnection, label: String) {
        peerConnection.statistics { report in
            let videoStats = report.statistics.values
                .filter { stat in
                    stat.type == "outbound-rtp" &&
                        ((stat.values["kind"] as? String) == "video" || (stat.values["mediaType"] as? String) == "video")
                }
            let keys = [
                "bytesSent",
                "packetsSent",
                "framesEncoded",
                "framesSent",
                "keyFramesEncoded",
                "hugeFramesSent",
                "nackCount",
                "firCount",
                "pliCount",
            ]
            let payloads = videoStats.map { stat in self.statPayload(stat, keys: keys) }
            self.storeOutboundStats(label: label, stats: payloads)
            if videoStats.isEmpty {
                print("[webrtc] Outbound stats \(label): no video outbound-rtp stats")
            } else {
                print("[webrtc] Outbound stats \(label): \(videoStats.map { self.statSummary($0, keys: keys) }.joined(separator: " | "))")
            }
        }
    }

    func outboundStatsSnapshot() -> [String: Any] {
        outboundStatsLock.lock()
        let stats = latestOutboundStats
        let label = latestOutboundStatsLabel
        let atNs = latestOutboundStatsAtNs
        outboundStatsLock.unlock()
        return [
            "label": label,
            "updatedAtNs": atNs,
            "reports": stats,
        ]
    }

    private func storeOutboundStats(label: String, stats: [[String: Any]]) {
        outboundStatsLock.lock()
        latestOutboundStatsLabel = label
        latestOutboundStatsAtNs = DispatchTime.now().uptimeNanoseconds
        latestOutboundStats = stats
        outboundStatsLock.unlock()
    }

    private func statPayload(_ stat: LKRTCStatistics, keys: [String]) -> [String: Any] {
        var payload: [String: Any] = ["id": stat.id, "type": stat.type]
        for key in keys {
            guard let value = stat.values[key] else { continue }
            payload[key] = statValue(value)
        }
        return payload
    }

    private func statValue(_ value: NSObject) -> Any {
        if let number = value as? NSNumber { return number }
        if let string = value as? NSString { return String(string) }
        return "\(value)"
    }

    private func statSummary(_ stat: LKRTCStatistics, keys: [String]) -> String {
        let values = keys.compactMap { key -> String? in
            guard let value = stat.values[key] else { return nil }
            return "\(key)=\(value)"
        }
        return "\(stat.id){\(values.joined(separator: " "))}"
    }
}
