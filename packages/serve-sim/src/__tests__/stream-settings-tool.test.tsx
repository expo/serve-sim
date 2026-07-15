import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamSettingsTool } from "../client/components/stream-settings-tool";

describe("StreamSettingsTool", () => {
  const settings = {
    transport: "http" as const,
    httpCodec: "h264" as const,
    webRtcCodec: "h264" as const,
    mjpegFps: 24,
    mjpegQuality: 0.8,
    maxDimension: 1024,
    h264Bitrate: 8_000_000,
    h264Fps: 24,
  };

  test("represents custom runtime encoder values instead of selecting a preset", () => {
    const html = renderToStaticMarkup(
      <StreamSettingsTool
        settings={settings}
        onPlaybackSettingsChange={() => {}}
        onEncoderSettingsChange={() => {}}
        activeCodec="h264"
        avccSupported
      />,
    );

    expect(html).toContain('<span class="block truncate">1024</span>');
    expect(html).toContain('<span class="block truncate">80%</span>');
    expect(html).toContain('<span class="block truncate">8 Mbps</span>');
    expect(html.match(/<span class="block truncate">24<\/span>/g)).toHaveLength(2);
  });

  test("keeps playback transport available but disables H.264 on unsupported browsers", () => {
    const html = renderToStaticMarkup(
      <StreamSettingsTool
        settings={settings}
        onPlaybackSettingsChange={() => {}}
        onEncoderSettingsChange={() => {}}
        activeCodec="mjpeg"
        avccSupported={false}
      />,
    );

    expect(html).not.toMatch(/aria-label="Transport"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="HTTP codec"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="H\.264 FPS"[^>]*disabled=""/);
  });
});
