import { LocationEmulationTool } from "../location-emulation-tool";
import { Panel, PanelCloseButton, PanelHeader, PanelTitle } from "../Panel";
import { execOnHost } from "../utils/exec";
import { AppDetectionTool } from "./app-detection-tool";
import { AppPermissionsTool } from "./app-permissions-tool";
import { AxTreeTool } from "./ax-tree-tool";
import { CameraTool } from "./camera-tool";
import { PANEL_BACKGROUND } from "./panel-colors";
import { SimulatorSettingsTool } from "./simulator-settings-tool";
import { StreamSettingsTool, type StreamSettings } from "./stream-settings-tool";

export function ToolsPanel({
  open,
  onClose,
  udid,
  deviceRuntime,
  currentApp,
  axOverlayEnabled,
  onToggleAxOverlay,
  streamSettings,
  onStreamSettingsChange,
  activeCodec,
  streamSettingsPending,
  width,
}: {
  open: boolean;
  onClose: () => void;
  udid: string;
  deviceRuntime: string | null;
  currentApp: { bundleId: string; isReactNative: boolean; pid?: number } | null;
  axOverlayEnabled: boolean;
  onToggleAxOverlay: () => void;
  streamSettings: StreamSettings;
  onStreamSettingsChange: (patch: Partial<StreamSettings>) => void;
  activeCodec: "webrtc" | "h264" | "mjpeg";
  streamSettingsPending: boolean;
  width: number;
}) {
  return (
    <Panel open={open} width={width} style={{ backgroundColor: PANEL_BACKGROUND }}>
      <PanelHeader>
        <PanelTitle>Tools</PanelTitle>
        <PanelCloseButton onClick={onClose} />
      </PanelHeader>

      {open && (
        <div className="p-3.5 overflow-y-auto flex-1 flex flex-col gap-3">
          <AppDetectionTool udid={udid} currentApp={currentApp} />
          <SimulatorSettingsTool udid={udid} runtime={deviceRuntime} />
          <AxTreeTool
            overlayEnabled={axOverlayEnabled}
            onToggleOverlay={onToggleAxOverlay}
          />
          <CameraTool udid={udid} bundleId={currentApp?.bundleId ?? null} />
          <LocationEmulationTool udid={udid} exec={execOnHost} />
          <AppPermissionsTool udid={udid} bundleId={currentApp?.bundleId ?? null} />
          <StreamSettingsTool
            settings={streamSettings}
            onSettingsChange={onStreamSettingsChange}
            activeCodec={activeCodec}
            disabled={streamSettingsPending}
          />
        </div>
      )}
    </Panel>
  );
}
