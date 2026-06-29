import Foundation
import CoreVideo
import CoreMedia
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

    private let queue = DispatchQueue(label: "webrtc-publisher")
    private let factory = LKRTCPeerConnectionFactory()
    private let videoSource: LKRTCVideoSource
    private let videoTrack: LKRTCVideoTrack
    private let capturer: LKRTCVideoCapturer
    private var session: WebRTCSession?
    var isActive: Bool {
        queue.sync { session != nil }
    }

    init() {
        videoSource = factory.videoSource(forScreenCast: true)
        videoTrack = factory.videoTrack(with: videoSource, trackId: "simulator-video")
        capturer = LKRTCVideoCapturer(delegate: videoSource)
        print("[webrtc] Publisher ready (factory + screen-cast video source)")
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

    func sendFrame(_ pixelBuffer: CVPixelBuffer, timestamp: CMTime) {
        queue.async {
            guard self.session != nil else { return }
            let captureTime = CMTimeGetSeconds(timestamp) * 1_000_000_000
            let timeNs = captureTime.isFinite && captureTime > 0
                ? Int64(captureTime)
                : Int64(DispatchTime.now().uptimeNanoseconds)
            let frame = LKRTCVideoFrame(
                buffer: LKRTCCVPixelBuffer(pixelBuffer: pixelBuffer),
                rotation: ._0,
                timeStampNs: timeNs
            )
            self.videoSource.capturer(self.capturer, didCapture: frame)
        }
    }

    func stop() {
        queue.sync {
            session?.close()
            session = nil
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
        config.continualGatheringPolicy = .gatherOnce
        config.iceServers = iceServers(from: request.iceServers)

        let constraints = LKRTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: ["DtlsSrtpKeyAgreement": "true"]
        )
        let delegate = WebRTCSessionDelegate(onInput: { [weak self] data in
            self?.onInput?(data)
        })
        guard let peerConnection = factory.peerConnection(
            with: config,
            constraints: constraints,
            delegate: delegate
        ) else {
            completion(.failure(makeError("Failed to create peer connection")))
            return
        }

        if let transceiver = peerConnection.addTransceiver(with: videoTrack) {
            applyVideoCodecPreference(request.codec, to: transceiver)
        } else {
            _ = peerConnection.add(videoTrack, streamIds: ["stream0"])
        }
        let session = WebRTCSession(peerConnection: peerConnection, delegate: delegate)
        self.session?.close()
        self.session = session

        let remoteDescription = LKRTCSessionDescription(type: .offer, sdp: request.sdp)
        peerConnection.setRemoteDescription(remoteDescription) { error in
            if let error {
                completion(.failure(error))
                return
            }
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
                    session.waitForIceGathering {
                        let local = peerConnection.localDescription ?? answer
                        completion(.success(WebRTCAnswerPayload(
                            type: LKRTCSessionDescription.string(for: local.type),
                            sdp: local.sdp
                        )))
                    }
                }
            }
        }
    }

    private func iceServers(from payload: [WebRTCIceServerPayload]?) -> [LKRTCIceServer] {
        let servers = payload ?? [
            WebRTCIceServerPayload(urls: ["stun:stun.l.google.com:19302"], username: nil, credential: nil),
            WebRTCIceServerPayload(urls: ["stun:stun1.l.google.com:19302"], username: nil, credential: nil),
        ]
        return servers.map { server in
            LKRTCIceServer(
                urlStrings: server.urls,
                username: server.username,
                credential: server.credential
            )
        }
    }

    private func applyVideoCodecPreference(_ codec: String?, to transceiver: LKRTCRtpTransceiver) {
        let preferredName: String
        switch codec?.lowercased() {
        case "vp8":
            preferredName = "VP8"
        case "vp9":
            preferredName = "VP9"
        default:
            preferredName = "H264"
        }
        let capabilities = factory.rtpSenderCapabilities(forKind: "video")
        let preferredCodecs = capabilities.codecs.filter {
            $0.name.caseInsensitiveCompare(preferredName) == .orderedSame ||
                $0.mimeType.caseInsensitiveCompare("video/\(preferredName)") == .orderedSame
        }
        guard !preferredCodecs.isEmpty else {
            print("[webrtc] No sender codec capability found for \(preferredName); using default order")
            return
        }
        let remainingCodecs = capabilities.codecs.filter { capability in
            !preferredCodecs.contains { $0 === capability }
        }
        let orderedCodecs = preferredCodecs + remainingCodecs
        transceiver.codecPreferences = orderedCodecs
        print("[webrtc] Preferred video codec: \(preferredName)")
    }

    private func makeError(_ message: String) -> Error {
        NSError(domain: "serve-sim.webrtc", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

private final class WebRTCSession {
    let peerConnection: LKRTCPeerConnection
    let delegate: WebRTCSessionDelegate

    init(peerConnection: LKRTCPeerConnection, delegate: WebRTCSessionDelegate) {
        self.peerConnection = peerConnection
        self.delegate = delegate
    }

    func waitForIceGathering(_ completion: @escaping () -> Void) {
        if peerConnection.iceGatheringState == .complete {
            completion()
            return
        }
        delegate.onIceGatheringComplete = completion
    }

    func close() {
        peerConnection.close()
    }
}

private final class WebRTCSessionDelegate: NSObject, LKRTCPeerConnectionDelegate, LKRTCDataChannelDelegate {
    var onIceGatheringComplete: (() -> Void)?
    private let onInput: (Data) -> Void

    init(onInput: @escaping (Data) -> Void) {
        self.onInput = onInput
    }

    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange stateChanged: LKRTCSignalingState) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didAdd stream: LKRTCMediaStream) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove stream: LKRTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: LKRTCPeerConnection) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceConnectionState) {
        print("[webrtc] ICE connection state: \(newState.rawValue)")
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceGatheringState) {
        if newState == .complete {
            let completion = onIceGatheringComplete
            onIceGatheringComplete = nil
            completion?()
        }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didOpen dataChannel: LKRTCDataChannel) {
        print("[webrtc] viewer opened data channel: \(dataChannel.label)")
        dataChannel.delegate = self
    }

    func dataChannelDidChangeState(_ dataChannel: LKRTCDataChannel) {}

    func dataChannel(_ dataChannel: LKRTCDataChannel, didReceiveMessageWith buffer: LKRTCDataBuffer) {
        onInput(buffer.data)
    }
}
