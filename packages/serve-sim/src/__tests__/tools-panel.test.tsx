import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
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
          codec: "auto",
          streamFps: 60,
          streamQuality: 0.7,
          streamMaxDimension: 720,
          h264Bitrate: 6_000_000,
          h264MaxFps: 60,
          webrtcCodec: "h264",
        }}
        onStreamSettingsChange={noop}
        activeCodec="h264"
        streamSettingsPending={false}
        width={320}
      />,
    );

    expect(html).toContain("background-color:var(--serve-sim-panel-bg)");
  });
});
