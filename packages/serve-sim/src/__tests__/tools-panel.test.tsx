import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InteractionSettingsTool } from "../client/components/interaction-settings-tool";
import { ToolsPanel } from "../client/components/tools-panel";

const noop = () => {};

describe("ToolsPanel", () => {
  test("uses the shared panel background variable", () => {
    const html = renderToStaticMarkup(
      <ToolsPanel
        open={false}
        onClose={noop}
        udid="one"
        deviceRuntime="iOS-27-0"
        currentApp={null}
        axOverlayEnabled={false}
        onToggleAxOverlay={noop}
        streamSettings={{
          transport: "http",
          httpCodec: "auto",
          webRtcCodec: "h264",
          mjpegFps: 60,
          mjpegQuality: 0.7,
          maxDimension: 0,
          h264Bitrate: 6_000_000,
          h264Fps: 60,
        }}
        onStreamPlaybackSettingsChange={noop}
        onStreamEncoderSettingsChange={noop}
        activeCodec="h264"
        avccSupported
        streamSettingsPending={false}
        interactive={false}
        onInteractiveChange={noop}
        width={320}
      />,
    );

    expect(html).toContain("background-color:var(--serve-sim-panel-bg)");
  });

  test("shows when simulator interaction is disabled", () => {
    const html = renderToStaticMarkup(
      <InteractionSettingsTool
        interactive={false}
        onInteractiveChange={noop}
      />,
    );

    expect(html).toContain("Interaction");
    expect(html).toContain('aria-label="Interactive"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("View-only");
  });
});
