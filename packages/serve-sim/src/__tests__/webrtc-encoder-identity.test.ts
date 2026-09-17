import { describe, expect, test } from "bun:test";
import { readSenderStats } from "../webrtc-sender-stats";

describe("encoder identity in sender stats", () => {
  test("reports the selected encoder so a software downgrade is visible", () => {
    const stats = readSenderStats({
      sessions: [],
      encoder: {
        id: "paravirtualized:com.apple.videotoolbox.videoencoder.ave.avc",
        hardware: true,
      },
    });
    expect(stats.encoder?.id).toBe(
      "paravirtualized:com.apple.videotoolbox.videoencoder.ave.avc",
    );
    expect(stats.encoder?.hardware).toBe(true);
  });

  test("marks a software encoder as such", () => {
    const stats = readSenderStats({
      sessions: [],
      encoder: { id: "com.apple.videotoolbox.videoencoder.h264", hardware: false },
    });
    expect(stats.encoder?.hardware).toBe(false);
  });

  test("tolerates a build that does not report an encoder", () => {
    expect(readSenderStats({ sessions: [] }).encoder).toBeNull();
  });

  test("carries the live session codec alongside the encoder id", () => {
    const stats = readSenderStats({
      sessions: [],
      encoder: { id: null, hardware: false, codec: "VP8" },
    });
    expect(stats.encoder).toEqual({ id: null, hardware: false, codec: "VP8" });
  });

  test("tolerates an encoder with no codec field", () => {
    const stats = readSenderStats({ sessions: [], encoder: { id: "x", hardware: true } });
    expect(stats.encoder).toEqual({ id: "x", hardware: true, codec: null });
  });

  /// Nothing connected reports nothing, which arrives as `{}`. Treating that as an encoder
  /// puts a bare "?" in the panel for the whole connection setup window.
  test("reports no encoder at all when the session has not connected", () => {
    expect(readSenderStats({ sessions: [], encoder: {} }).encoder).toBeNull();
  });
});
