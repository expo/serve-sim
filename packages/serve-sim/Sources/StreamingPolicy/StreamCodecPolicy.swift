import Foundation

/// Which codec a set of live sessions is on, and what that implies about the encoder.
public enum StreamCodecPolicy {
    public static func isH264(_ codecName: String) -> Bool {
        codecName.caseInsensitiveCompare("H264") == .orderedSame
    }

    /// The codec to report for several sessions. H.264 wins so one software session cannot
    /// mask a live hardware one.
    public static func dominant(_ codecNames: [String]) -> String? {
        let named = codecNames.filter { !$0.isEmpty }
        return named.first(where: isH264) ?? named.first
    }

    /// `"video/H264"` -> `"H264"`. Nil for anything without a subtype.
    public static func codecName(fromMimeType mimeType: String) -> String? {
        let parts = mimeType.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[1].isEmpty else { return nil }
        return String(parts[1])
    }

    /// Whether the encoder probe describes what a live session is really using.
    ///
    /// The probe answers "which H.264 encoder would this host use". libwebrtc encodes VP8
    /// and VP9 in software, so lending them the probe claimed hardware for a software
    /// stream, which is the downgrade this field exists to expose. With no session the
    /// probe is still the honest answer: it describes the host, not a stream.
    public static func probeDescribesLiveCodec(_ codecNames: [String]) -> Bool {
        guard let codec = dominant(codecNames) else { return true }
        return isH264(codec)
    }
}
