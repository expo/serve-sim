public struct WebRTCFieldTrialPolicy: Equatable, Sendable {
    public let configuration: String

    public init(playoutDelayMaxMilliseconds: Int) {
        let playoutDelayMaxMilliseconds = max(
            0,
            min(1_000, playoutDelayMaxMilliseconds)
        )

        configuration =
            "WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:\(playoutDelayMaxMilliseconds)/"
            // React after WebRTC's minimum supported ten-frame evidence window.
            + "WebRTC-Video-QualityScalerSettings/"
            + "sampling_period_ms:16,min_frames:10,initial_scale_factor:31.25/"
            // Downscale sooner, suppress automatic upscale, and use the latest
            // high-QP sample instead of retaining a long static-scene history.
            + "WebRTC-Video-QualityScaling/"
            + "Enabled-1,85,149,205,24,37,26,36,0,0.9999,1/"
            // Raise VP8's quantizer ceiling to add compression headroom before
            // rate control has to drop a frame.
            + "WebRTC-VideoRateControl/vp8_qp_max:63/"
    }
}
