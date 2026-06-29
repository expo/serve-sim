import { useState } from "react";
import { SlidersHorizontal, Video } from "lucide-react";
import { CollapsibleSection } from "./collapsible-section";
import { SettingRow, SettingSelect } from "./simulator-settings-tool";

export type StreamTransport = "http" | "webrtc";
export type StreamHttpCodec = "auto" | "mjpeg" | "h264";
export type StreamWebRTCCodec = "vp8" | "vp9" | "h264";

export interface StreamSettings {
  transport: StreamTransport;
  codec: StreamHttpCodec;
  streamFps: number;
  streamQuality: number;
  streamMaxDimension: number;
  h264Bitrate: number;
  h264MaxFps: number;
  webrtcCodec: StreamWebRTCCodec;
}

const TRANSPORT_OPTIONS = [
  { value: "http", label: "HTTP" },
  { value: "webrtc", label: "WebRTC" },
];
const HTTP_CODEC_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "h264", label: "H.264" },
  { value: "mjpeg", label: "MJPEG" },
];
const WEBRTC_CODEC_OPTIONS = [
  { value: "h264", label: "H.264" },
  { value: "vp9", label: "VP9" },
  { value: "vp8", label: "VP8" },
];
const MAX_DIMENSION_OPTIONS = [
  { value: "0", label: "Full" },
  { value: "1920", label: "1920" },
  { value: "1600", label: "1600" },
  { value: "1280", label: "1280" },
  { value: "960", label: "960" },
  { value: "720", label: "720" },
];
const FPS_OPTIONS = ["60", "30", "20", "15", "10", "5"].map((value) => ({ value, label: value }));
const QUALITY_OPTIONS = [
  { value: "0.45", label: "45%" },
  { value: "0.55", label: "55%" },
  { value: "0.7", label: "70%" },
  { value: "0.85", label: "85%" },
  { value: "1", label: "100%" },
];
const BITRATE_OPTIONS = [
  { value: "1500000", label: "1.5 Mbps" },
  { value: "3000000", label: "3 Mbps" },
  { value: "6000000", label: "6 Mbps" },
  { value: "10000000", label: "10 Mbps" },
  { value: "16000000", label: "16 Mbps" },
];

const iconClass = "size-3.5";

function selectValue(value: number, options: Array<{ value: string; label: string }>): string {
  const rounded = String(Number.isInteger(value) ? Math.round(value) : value);
  return options.some((option) => option.value === rounded) ? rounded : String(value);
}

export function StreamSettingsTool({
  settings,
  onSettingsChange,
  activeCodec,
  disabled = false,
}: {
  settings: StreamSettings;
  onSettingsChange: (patch: Partial<StreamSettings>) => void;
  activeCodec: "webrtc" | "h264" | "mjpeg";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const httpActive = settings.transport === "http";
  const webrtcActive = settings.transport === "webrtc";

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      data-stream-settings=""
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">
            Stream
          </span>
          <span className="text-[11px] text-white/40 justify-self-end uppercase tracking-[0.08em]">
            {activeCodec}
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-1.5 pb-1.5">
        <SettingRow icon={<Video className={iconClass} />} label="Transport">
          <SettingSelect
            label="Transport"
            value={settings.transport}
            options={TRANSPORT_OPTIONS}
            disabled={disabled}
            onChange={(v) => onSettingsChange({ transport: v as StreamTransport })}
          />
        </SettingRow>
        <SettingRow icon={<Video className={iconClass} />} label="HTTP codec">
          <SettingSelect
            label="HTTP codec"
            value={settings.codec}
            options={HTTP_CODEC_OPTIONS}
            disabled={disabled || !httpActive}
            onChange={(v) => onSettingsChange({ codec: v as StreamHttpCodec })}
          />
        </SettingRow>
        <SettingRow icon={<Video className={iconClass} />} label="WebRTC codec">
          <SettingSelect
            label="WebRTC codec"
            value={settings.webrtcCodec}
            options={WEBRTC_CODEC_OPTIONS}
            disabled={disabled || !webrtcActive}
            onChange={(v) => onSettingsChange({ webrtcCodec: v as StreamWebRTCCodec })}
          />
        </SettingRow>
        <SettingRow icon={<SlidersHorizontal className={iconClass} />} label="Max size">
          <SettingSelect
            label="Max size"
            value={selectValue(settings.streamMaxDimension, MAX_DIMENSION_OPTIONS)}
            options={MAX_DIMENSION_OPTIONS}
            disabled={disabled}
            onChange={(v) => onSettingsChange({ streamMaxDimension: Number(v) })}
          />
        </SettingRow>
        <SettingRow icon={<SlidersHorizontal className={iconClass} />} label="MJPEG FPS">
          <SettingSelect
            label="MJPEG FPS"
            value={selectValue(settings.streamFps, FPS_OPTIONS)}
            options={FPS_OPTIONS}
            disabled={disabled || !httpActive}
            onChange={(v) => onSettingsChange({ streamFps: Number(v) })}
          />
        </SettingRow>
        <SettingRow icon={<SlidersHorizontal className={iconClass} />} label="MJPEG quality">
          <SettingSelect
            label="MJPEG quality"
            value={selectValue(settings.streamQuality, QUALITY_OPTIONS)}
            options={QUALITY_OPTIONS}
            disabled={disabled || !httpActive}
            onChange={(v) => onSettingsChange({ streamQuality: Number(v) })}
          />
        </SettingRow>
        <SettingRow icon={<SlidersHorizontal className={iconClass} />} label="H.264 FPS">
          <SettingSelect
            label="H.264 FPS"
            value={selectValue(settings.h264MaxFps, FPS_OPTIONS)}
            options={FPS_OPTIONS}
            disabled={disabled || !httpActive || settings.codec === "mjpeg"}
            onChange={(v) => onSettingsChange({ h264MaxFps: Number(v) })}
          />
        </SettingRow>
        <SettingRow icon={<SlidersHorizontal className={iconClass} />} label="H.264 bitrate">
          <SettingSelect
            label="H.264 bitrate"
            value={selectValue(settings.h264Bitrate, BITRATE_OPTIONS)}
            options={BITRATE_OPTIONS}
            disabled={disabled || !httpActive || settings.codec === "mjpeg"}
            onChange={(v) => onSettingsChange({ h264Bitrate: Number(v) })}
          />
        </SettingRow>
      </div>
    </CollapsibleSection>
  );
}
