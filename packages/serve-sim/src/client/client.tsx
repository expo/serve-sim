import { createRoot } from "react-dom/client";
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  SimulatorView,
  digitalCrownDeltaFromWheel,
  displayStreamConfig,
  fallbackScreenSize,
  isLandscapeConfig,
  screenBorderRadius,
  SimulatorToolbar,
  getDeviceType,
  simulatorAspectRatio,
  simulatorMaxWidth,
  ROTATE_LEFT_CYCLE,
  ROTATE_RIGHT_CYCLE,
  type DeviceType,
  type SimulatorOrientation,
  type StreamConfig,
} from "./simulator";

import { Globe, Maximize2, PanelRight, Upload } from "lucide-react";
import { ReloadIcon } from "./icons";
import { AxDomOverlay } from "./components/ax-dom-overlay";
import { AxStateProvider } from "./components/ax-state-provider";
import { AxToolbarButton } from "./components/ax-toolbar-button";
import { DeviceSidebarToggle } from "./components/device-sidebar-toggle";
import { DevicePlaceholder } from "./components/device-placeholder";
import { PresentationControls } from "./components/presentation-controls";
import { IconButton } from "./components/icon-button";
import { DeviceKitChrome, type ChromeButtonPress } from "./components/device-chrome-frame";
import { GridPanel } from "./components/grid-panel";
import { ResizeHandle } from "./components/resize-handle";
import { SimulatorResizeCornerHandle } from "./components/simulator-resize-corner-handle";
import { ServeSimToaster } from "./components/app-toasts";
import { SimulatorResizeSizeBadge } from "./components/simulator-resize-size-badge";
import { StreamStatusPill } from "./components/stream-status-pill";
import { ToolsPanel } from "./components/tools-panel";
import { WebKitDevtoolsPanel } from "./components/webkit-devtools-panel";
import { useMediaDrop } from "./hooks/use-media-drop";
import { useMjpegStream } from "./hooks/use-mjpeg-stream";
import { useAvccStream } from "./hooks/use-avcc-stream";
import { useWebRtcStream } from "./hooks/use-webrtc-stream";
import { GestureStamper, HidTransportRouter } from "./webrtc-input-channel";
import { useResizableWidth } from "./hooks/use-resizable-width";
import { useScreenshotToast } from "./hooks/use-screenshot-toast";
import { useSimulatorResize } from "./hooks/use-simulator-resize";
import { useUploadToasts } from "./hooks/use-upload-toasts";
import { useWebKitDevtools } from "./hooks/use-webkit-devtools";
import { useGridDevices } from "./hooks/use-grid-devices";
import { useStreamSettings } from "./hooks/use-stream-settings";
import type { DeviceKitChromeDescriptor } from "./utils/grid";
import {
  avccFallbackReducer,
  initialAvccFallback,
  AVCC_FRAME_TIMEOUT_MS,
} from "./avcc-fallback";
import { fileExtension } from "./utils/drop";
import { execOnHost, openHostEventStream } from "./utils/exec";
import { hidUsageForCode } from "./utils/hid";
import {
  DEVICE_SIDEBAR_WIDTH,
  DEVTOOLS_PANEL_WIDTH,
  PANEL_WIDTH,
} from "./utils/panel-widths";
import { proxyPreviewConfigForBrowser } from "./utils/preview-config";
import { mjpegStreamUrlFrom, simEndpoint, streamConfigFrom, webrtcCloseUrlFrom, webrtcOfferUrlFrom, webrtcStatsUrlFrom } from "./utils/sim-endpoint";
import { shouldStreamSimulatorLogs } from "./utils/simulator-logs";
import { useBlockPageZoom } from "./hooks/use-block-page-zoom";
import { useCoarsePointer } from "./hooks/use-coarse-pointer";
import {
  escapeKeyOutcome,
  presentationModeFromSearch,
  writeFullscreenSearchParam,
} from "./utils/presentation";
import {
  getPresentationFrameWidth,
  roundToDevicePixel,
  SIMULATOR_RESIZE_DRAG_TRANSITION,
  SIMULATOR_RESIZE_LAYOUT_TRANSITION,
  SIMULATOR_RESIZE_PAGE_TRANSITION,
  SIMULATOR_RESIZE_PRESENTATION_TRANSITION,
  SIMULATOR_RESIZE_PRESENTATION_TRANSITION_MS,
  SIMULATOR_RESIZE_VIEWPORT_INSET_FOR_PRESENTATION,
} from "./utils/simulator-resize";
import {
  encodeWsMessage,
  flushWsMessageQueue,
  sendOrQueueWsMessage,
  type QueuedWsMessage,
} from "./utils/ws-send-queue";
import {
  webRtcFallbackDecision,
  type WebRtcCodec,
} from "./webrtc-codec-fallback";

// ─── App ───

type PreviewConfig = NonNullable<Window["__SIM_PREVIEW__"]>;

function previewConfigKey(config: PreviewConfig | null): string {
  return config
    ? `${config.device}:${config.pid}:${config.streamUrl}:${config.wsUrl}:${JSON.stringify(config.streamSettings ?? null)}`
    : "";
}

function App() {
  const [config, setConfig] = useState<PreviewConfig | null>(() =>
    proxyPreviewConfigForBrowser(streamConfigFrom(window.__SIM_PREVIEW__), window.location)
  );
  const [streaming, setStreaming] = useState(false);
  // The device the user wants to view. Selecting a row in the sidebar updates
  // this and re-subscribes the SSE below — the main view swaps streams instantly
  // (or shows a Start placeholder) without a full page reload.
  const [selectedUdid, setSelectedUdid] = useState<string | null>(() => {
    const c = streamConfigFrom(window.__SIM_PREVIEW__);
    if (c) return c.device;
    return new URLSearchParams(window.location.search).get("device");
  });
  const [axOverlayEnabled, setAxOverlayEnabled] = useState(false);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [chromeEnabled, setChromeEnabled] = useState(() =>
    typeof window === "undefined" ? true : !window.matchMedia("(pointer: coarse)").matches,
  );
  const [presentationBoot] = useState(() =>
    typeof window === "undefined"
      ? { initial: false, embedLocked: false }
      : presentationModeFromSearch(window.location.search),
  );
  const embedLocked = presentationBoot.embedLocked;
  const [presentation, setPresentation] = useState(presentationBoot.initial);
  const presentationRef = useRef(presentation);
  presentationRef.current = presentation;
  const swallowEscapeRef = useRef(false);
  const [chromeGone, setChromeGone] = useState(presentationBoot.initial);
  useEffect(() => {
    if (!presentation) {
      setChromeGone(false);
      return;
    }
    const id = setTimeout(() => setChromeGone(true), SIMULATOR_RESIZE_PRESENTATION_TRANSITION_MS);
    return () => clearTimeout(id);
  }, [presentation]);
  // Open the sidebar by default when the viewport has room for it beside the
  // simulator; narrow windows keep it collapsed so the device isn't squeezed.
  const [gridOpen, setGridOpen] = useState(() => {
    if (typeof window === "undefined" || presentationBoot.initial) return false;
    return window.innerWidth >= DEVICE_SIDEBAR_WIDTH + 640;
  });
  const { width: gridPanelWidth, onPointerDown: onGridResize } = useResizableWidth(
    "serve-sim:device-sidebar-width",
    DEVICE_SIDEBAR_WIDTH,
    240,
    640,
    "right",
  );
  const [selectedDevtoolsTargetId, setSelectedDevtoolsTargetId] = useState<string | null>(null);

  // Grid device list + boot/shutdown actions, shared by the sidebar and the
  // main placeholder. Endpoints resolve from simEndpoint so this also works in
  // the no-helper empty state (the grid routes are always served).
  const preview = window.__SIM_PREVIEW__;
  const gridCatalogEndpoint = preview?.gridCatalogEndpoint ?? simEndpoint("grid/api/catalog");
  const gridStatusEndpoint = preview?.gridStatusEndpoint ?? simEndpoint("grid/api/status");
  const gridStatusEventsEndpoint = preview?.gridStatusEventsEndpoint ?? simEndpoint("grid/api/status/events");
  const gridStartEndpoint = preview?.gridStartEndpoint ?? simEndpoint("grid/api/start");
  const gridShutdownEndpoint = preview?.gridShutdownEndpoint ?? simEndpoint("grid/api/shutdown");
  const [starting, setStarting] = useState<Record<string, boolean>>({});
  const [shuttingDown, setShuttingDown] = useState<Record<string, boolean>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string | null>>({});
  const {
    devices: gridDevices,
    total: gridTotal,
    loadMore: loadMoreGrid,
    loadAll: loadAllGrid,
    resetPage: resetGridPage,
    hasMore: gridHasMore,
  } = useGridDevices(
    gridCatalogEndpoint,
    gridStatusEventsEndpoint,
    true,
    selectedUdid,
  );
  // Re-subscribe the stream SSE the instant the selected device gains (or loses)
  // a helper, so its config lands as soon as it boots rather than waiting on the
  // next filesystem-watch tick — the stream appears sooner after boot.
  const selectedHasHelper = !!(
    selectedUdid && gridDevices?.find((d) => d.device === selectedUdid)?.helper
  );

  const selectDevice = useCallback((udid: string) => {
    setSelectedUdid(udid);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("device", udid);
      window.history.replaceState(null, "", u.toString());
    } catch {}
  }, []);

  const enterPresentation = useCallback(() => {
    setPresentation(true);
    setGridOpen(false);
    if (!embedLocked) writeFullscreenSearchParam(true);
  }, [embedLocked]);

  const exitPresentation = useCallback(() => {
    if (embedLocked) return;
    setPresentation(false);
    writeFullscreenSearchParam(false);
  }, [embedLocked]);

  useEffect(() => {
    if (embedLocked) return;
    const onKey = (e: KeyboardEvent) => {
      // `key`, not `code`: synthetic input often omits `code`.
      if (e.key !== "Escape") return;
      const outcome = escapeKeyOutcome(
        { type: e.type === "keyup" ? "keyup" : "keydown", repeat: e.repeat },
        { presentation: presentationRef.current, swallowing: swallowEscapeRef.current },
      );
      swallowEscapeRef.current = outcome.swallowing;
      if (!outcome.swallow) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (outcome.exit) exitPresentation();
    };
    // A blur mid-press never delivers the keyup.
    const onBlur = () => {
      swallowEscapeRef.current = false;
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [embedLocked, exitPresentation]);

  const waitForHelper = useCallback(
    async (udid: string, timeoutMs = 20_000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const endpoint = new URL(gridStatusEndpoint, window.location.href);
          endpoint.searchParams.set("device", udid);
          const res = await fetch(endpoint, { cache: "no-store" });
          const json = await res.json();
          if ((json.statuses ?? []).some((d: any) => d.device === udid && d.helper)) return true;
        } catch {}
        await new Promise((r) => setTimeout(r, 400));
      }
      return false;
    },
    [gridStatusEndpoint],
  );

  const startDevice = useCallback(
    async (udid: string) => {
      setStarting((p) => ({ ...p, [udid]: true }));
      setActionErrors((e) => ({ ...e, [udid]: null }));
      try {
        const res = await fetch(gridStartEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ udid }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) {
          setActionErrors((e) => ({ ...e, [udid]: json.error ?? `HTTP ${res.status}` }));
          return;
        }
        // The helper registers asynchronously; once it does, the SSE (subscribed
        // to this udid) delivers its config and the main view starts streaming.
        await waitForHelper(udid);
      } catch (err: any) {
        setActionErrors((e) => ({ ...e, [udid]: err?.message ?? "Request failed" }));
      } finally {
        setStarting((p) => ({ ...p, [udid]: false }));
      }
    },
    [gridStartEndpoint, waitForHelper],
  );

  const shutdownDevice = useCallback(
    async (udid: string) => {
      setShuttingDown((s) => ({ ...s, [udid]: true }));
      setActionErrors((e) => ({ ...e, [udid]: null }));
      try {
        const res = await fetch(gridShutdownEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ udid }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) {
          setActionErrors((e) => ({ ...e, [udid]: json.error ?? `HTTP ${res.status}` }));
        }
      } catch (err: any) {
        setActionErrors((e) => ({ ...e, [udid]: err?.message ?? "Request failed" }));
      } finally {
        setShuttingDown((s) => ({ ...s, [udid]: false }));
      }
    },
    [gridShutdownEndpoint],
  );

  // Pick a sensible default device once the grid loads and nothing is selected:
  // prefer a live helper, then a booted sim, then the first available.
  useEffect(() => {
    if (selectedUdid) return;
    if (config?.device) {
      setSelectedUdid(config.device);
      return;
    }
    if (!gridDevices || gridDevices.length === 0) return;
    const pick =
      gridDevices.find((d) => d.helper) ??
      gridDevices.find((d) => d.state === "Booted") ??
      gridDevices[0];
    if (pick) setSelectedUdid(pick.device);
  }, [selectedUdid, config?.device, gridDevices]);

  // Subscribe to the selected device's stream config. Re-runs on selection
  // change so switching devices swaps the stream without reloading the page.
  useEffect(() => {
    const eventsUrl = `${simEndpoint("api/events")}${selectedUdid ? `?device=${encodeURIComponent(selectedUdid)}` : ""}`;

    const applyConfig = (next: PreviewConfig | null) => {
      setConfig((prev) => {
        next = proxyPreviewConfigForBrowser(streamConfigFrom(next), window.location);
        if (previewConfigKey(prev) === previewConfigKey(next)) return prev;
        if (next) {
          window.__SIM_PREVIEW__ = next;
        } else if (window.__SIM_PREVIEW__) {
          // Keep the minimal injection: the empty state still routes through
          // simEndpoint (basePath) and authenticates /exec (execToken).
          const { basePath, execToken } = window.__SIM_PREVIEW__;
          window.__SIM_PREVIEW__ = { basePath, execToken } as Window["__SIM_PREVIEW__"];
        }
        return next;
      });
    };

    // Server pushes the serve-sim state only when it actually changes (helper
    // boot/shutdown or device selection), so there's no polling loop here.
    const es = openHostEventStream(eventsUrl);
    es.onmessage = (event) => {
      try {
        applyConfig(streamConfigFrom(JSON.parse(event.data) as Window["__SIM_PREVIEW__"]));
      } catch {}
    };
    return () => es.close();
  }, [selectedUdid, selectedHasHelper]);

  // Stream simctl logs into the browser console with colors + grouping. The
  // full simulator log is too expensive to send through remote tunnels by
  // default; remote previews can opt in with `?logs=1`.
  useEffect(() => {
    if (!config?.logsEndpoint || !shouldStreamSimulatorLogs(window.location)) return;
    const es = openHostEventStream(config.logsEndpoint);

    const procColors = new Map<string, string>();
    const palette = [
      "#8be9fd", "#50fa7b", "#ffb86c", "#ff79c6", "#bd93f9",
      "#f1fa8c", "#6272a4", "#ff5555", "#69ff94", "#d6acff",
      "#ffffa5", "#a4ffff", "#ff6e6e", "#caa9fa", "#5af78e",
    ];
    function colorFor(name: string): string {
      let c = procColors.get(name);
      if (!c) {
        let h = 0;
        for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
        c = palette[Math.abs(h) % palette.length]!;
        procColors.set(name, c);
      }
      return c;
    }

    let lastProc = "";
    let groupOpen = false;

    es.onmessage = (event) => {
      try {
        const entry = JSON.parse(event.data);
        const proc = entry.processImagePath?.split("/").pop() ?? entry.senderImagePath?.split("/").pop() ?? "";
        const subsystem = entry.subsystem ?? "";
        const category = entry.category ?? "";
        const msg = entry.eventMessage ?? "";
        if (!msg) return;

        if (proc !== lastProc) {
          if (groupOpen) console.groupEnd();
          const color = colorFor(proc);
          console.groupCollapsed(
            `%c${proc}${subsystem ? ` %c${subsystem}${category ? ":" + category : ""}` : ""}`,
            `color:${color};font-weight:bold`,
            ...(subsystem ? ["color:#888;font-weight:normal"] : []),
          );
          groupOpen = true;
          lastProc = proc;
        }

        const level = (entry.messageType ?? "").toLowerCase();
        const tag = subsystem && proc === lastProc
          ? `%c${category || subsystem}%c `
          : "";
        const tagStyles = tag
          ? ["color:#888;font-style:italic", "color:inherit"]
          : [];

        if (level === "fault" || level === "error") {
          console.log(`${tag}%c${msg}`, ...tagStyles, "color:#ff5555");
        } else if (level === "debug") {
          console.log(`${tag}%c${msg}`, ...tagStyles, "color:#6272a4");
        } else {
          console.log(`${tag}%c${msg}`, ...tagStyles, "color:inherit");
        }
      } catch {}
    };

    return () => {
      if (groupOpen) console.groupEnd();
      es.close();
    };
  }, [config?.logsEndpoint]);

  // Selection drives the view: stream when the selected device's helper config
  // has arrived, otherwise a placeholder (connecting / boot-and-start).
  const effectiveUdid = selectedUdid ?? config?.device ?? null;
  const selectedDevice = gridDevices?.find((d) => d.device === effectiveUdid) ?? null;
  // The catalog is a fetch behind the inlined config, so until it lands the
  // device would lay out at the bare screen aspect and then reflow into its bezel.
  const inlineChrome =
    window.__SIM_PREVIEW__?.device === effectiveUdid
      ? window.__SIM_PREVIEW__?.chrome ?? null
      : null;
  const isStreaming = !!config && config.device === effectiveUdid;

  let mainView: ReactNode;
  if (isStreaming && config) {
    mainView = (
      <AppWithConfig
        config={config}
        deviceName={selectedDevice?.name ?? null}
        deviceRuntime={selectedDevice?.runtime ?? null}
        chrome={selectedDevice?.chrome ?? inlineChrome}
        axOverlayEnabled={axOverlayEnabled}
        setAxOverlayEnabled={setAxOverlayEnabled}
        devtoolsOpen={devtoolsOpen}
        setDevtoolsOpen={setDevtoolsOpen}
        gridOpen={gridOpen}
        setGridOpen={setGridOpen}
        gridPanelWidth={gridPanelWidth}
        selectedDevtoolsTargetId={selectedDevtoolsTargetId}
        setSelectedDevtoolsTargetId={setSelectedDevtoolsTargetId}
        streaming={streaming}
        setStreaming={setStreaming}
        presentation={presentation}
        onEnterPresentation={enterPresentation}
        onExitPresentation={exitPresentation}
        embedLocked={embedLocked}
        chromeEnabled={chromeEnabled}
        setChromeEnabled={setChromeEnabled}
      />
    );
  } else {
    const leftPad = gridOpen ? gridPanelWidth + 36 : 24;
    mainView = (
      <div
        className="h-dvh flex flex-col items-center justify-center gap-3 bg-page font-system box-border [transition:padding_0.25s_ease]"
        style={{ paddingLeft: leftPad, paddingRight: 24 }}
      >
        {selectedDevice ? (
          <DevicePlaceholder
            name={selectedDevice.name}
            runtime={selectedDevice.runtime}
            chrome={selectedDevice.chrome ?? null}
            placeholderAsset={selectedDevice.placeholderAsset ?? null}
            busy={!!selectedDevice.helper || !!starting[selectedDevice.device]}
            busyLabel={selectedDevice.helper ? "Connecting…" : "Starting…"}
            error={actionErrors[selectedDevice.device] ?? null}
            onStart={() => startDevice(selectedDevice.device)}
          />
        ) : gridDevices ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <h1 className="text-[18px] m-0 text-white/90">No simulators available</h1>
            <p className="text-white/55 text-[14px] max-w-120">
              Create a simulator in Xcode, or start one with{" "}
              <code className="bg-[#222] px-1.5 py-0.5 rounded text-[13px]">bunx @expo/serve-sim --detach</code>.
            </p>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      {mainView}
      <ServeSimToaster />
      {/* Persistent left device sidebar — overlays every main view so swapping
          streams never remounts (and refetches) the picker. */}
      <div
        aria-hidden={presentation}
        style={{
          opacity: presentation ? 0 : 1,
          // `visibility`, not `hidden`: an unrendered element has no opacity to
          // fade back in from. Still keeps it out of the tab order.
          visibility: chromeGone ? "hidden" : "visible",
          pointerEvents: presentation ? "none" : undefined,
          transition: `opacity ${SIMULATOR_RESIZE_PRESENTATION_TRANSITION_MS}ms ease`,
        }}
      >
        <GridPanel
          open={gridOpen}
          onClose={() => setGridOpen(false)}
          width={gridPanelWidth}
          side="left"
          devices={gridDevices}
          total={gridTotal}
          hasMore={gridHasMore}
          onLoadMore={loadMoreGrid}
          onLoadAll={loadAllGrid}
          onResetPage={resetGridPage}
          selectedUdid={effectiveUdid}
          onSelect={selectDevice}
          starting={starting}
          shuttingDown={shuttingDown}
          onShutdown={shutdownDevice}
        />
        <ResizeHandle
          panelWidth={gridPanelWidth}
          visible={gridOpen}
          onPointerDown={onGridResize}
          ariaLabel="Resize simulators sidebar"
          side="left"
        />
        <DeviceSidebarToggle open={gridOpen} onClick={() => setGridOpen(true)} />
      </div>
    </>
  );
}

interface AppWithConfigProps {
  config: PreviewConfig;
  deviceName: string | null;
  deviceRuntime: string | null;
  chrome: DeviceKitChromeDescriptor | null;
  axOverlayEnabled: boolean;
  setAxOverlayEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  devtoolsOpen: boolean;
  setDevtoolsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  gridOpen: boolean;
  setGridOpen: React.Dispatch<React.SetStateAction<boolean>>;
  gridPanelWidth: number;
  selectedDevtoolsTargetId: string | null;
  setSelectedDevtoolsTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  streaming: boolean;
  setStreaming: (v: boolean) => void;
  presentation: boolean;
  onEnterPresentation: () => void;
  onExitPresentation: () => void;
  embedLocked: boolean;
  chromeEnabled: boolean;
  setChromeEnabled: React.Dispatch<React.SetStateAction<boolean>>;
}

function AppWithConfig({
  config,
  deviceName,
  deviceRuntime,
  chrome,
  axOverlayEnabled,
  setAxOverlayEnabled,
  devtoolsOpen,
  setDevtoolsOpen,
  gridOpen,
  setGridOpen,
  gridPanelWidth,
  selectedDevtoolsTargetId,
  setSelectedDevtoolsTargetId,
  streaming,
  setStreaming,
  presentation,
  onEnterPresentation,
  onExitPresentation,
  embedLocked,
  chromeEnabled,
  setChromeEnabled,
}: AppWithConfigProps) {
  useEffect(() => {
    document.title = deviceName ? `Simulator - ${deviceName}` : "Simulator Preview";
  }, [deviceName]);
  const coarsePointer = useCoarsePointer();
  useBlockPageZoom(coarsePointer);

  const deviceType: DeviceType = getDeviceType(deviceName);
  const devtools = useWebKitDevtools(config.devtoolsEndpoint ?? simEndpoint("devtools"), devtoolsOpen);

  useEffect(() => {
    if (!devtoolsOpen) return;
    if (selectedDevtoolsTargetId && devtools.targets.some((target) => target.id === selectedDevtoolsTargetId)) return;
    setSelectedDevtoolsTargetId(devtools.targets.length === 1 ? devtools.targets[0]!.id : null);
  }, [devtoolsOpen, devtools.targets, selectedDevtoolsTargetId, setSelectedDevtoolsTargetId]);

  useEffect(() => {
    setSelectedDevtoolsTargetId(null);
  }, [config.device, setSelectedDevtoolsTargetId]);

  // Prefer H.264 (AVCC via WebCodecs) when the browser supports it; otherwise
  // fall back to MJPEG. The MJPEG reader stays dormant (null url) under AVCC so
  // we never pull both streams at once. The AVCC frames are decoded view-side
  // by SimulatorView's `useAvccStream`; this hook just reports browser support.
  //
  // Browser support is necessary but not sufficient: native H.264 encoding can
  // still fail on a constrained host. If no frame decodes during the startup
  // window, `avccFallback` drops to MJPEG. See avcc-fallback.ts.
  const avcc = useAvccStream();
  const streamSettingsState = useStreamSettings({
    device: config.device,
    endpoint: config.streamSettingsEndpoint,
    initialSettings: config.streamSettings,
  });
  const streamSettings = streamSettingsState.settings;
  const updateStreamPlayback = streamSettingsState.updatePlayback;
  const streamTransportLocked = streamSettingsState.transportLocked;

  const wantsWebRtcVideo = streamSettings.transport === "webrtc";
  const handledWebRtcFailureRef = useRef<string | null>(null);
  const useWebRtcVideo = wantsWebRtcVideo;
  const [webRtcCodecOverride, setWebRtcCodecOverride] = useState<WebRtcCodec | null>(null);
  const configuredWebRtcCodec = streamSettings.webRtcCodec;
  const effectiveWebRtcCodec = webRtcCodecOverride ?? configuredWebRtcCodec;
  const webrtc = useWebRtcStream({
    offerUrl: webrtcOfferUrlFrom(config),
    closeUrl: webrtcCloseUrlFrom(config),
    enabled: useWebRtcVideo,
    codec: effectiveWebRtcCodec,
    iceServers: streamSettings.iceServers,
  });
  const [avccFallback, dispatchAvccFallback] = useReducer(
    avccFallbackReducer,
    initialAvccFallback,
  );
  // `?codec=mjpeg` forces the JPEG fallback path even where WebCodecs exists —
  // an escape hatch for browsers whose H.264 decode misbehaves, and the way to
  // exercise the MJPEG pipeline in a browser that would otherwise pick AVCC.
  const [forceMjpeg] = useState(
    () => new URLSearchParams(window.location.search).get("codec") === "mjpeg",
  );
  const useMjpegHttp = streamSettings.httpCodec === "mjpeg";
  const useAvccVideo =
    !useWebRtcVideo &&
    !useMjpegHttp &&
    avcc.supported &&
    !avccFallback.fellBack &&
    !forceMjpeg;
  const mjpeg = useMjpegStream(useAvccVideo || useWebRtcVideo ? null : mjpegStreamUrlFrom(config));

  // Re-arm AVCC whenever the target stream changes (device switch / reconnect).
  useEffect(() => {
    setStreaming(false);
    dispatchAvccFallback("reset");
    setWebRtcCodecOverride(null);
  }, [
    config.streamUrl,
    setStreaming,
    streamSettings.transport,
    streamSettings.httpCodec,
    streamSettings.webRtcCodec,
  ]);
  useEffect(() => {
    if (!wantsWebRtcVideo || !webrtc.failure) return;
    if (handledWebRtcFailureRef.current === webrtc.failure.sessionId) return;
    handledWebRtcFailureRef.current = webrtc.failure.sessionId;
    const decision = webRtcFallbackDecision(
      configuredWebRtcCodec,
      effectiveWebRtcCodec,
      webrtc.failure,
    );
    if (!decision) return;
    if (decision.type === "switch-to-http") {
      if (streamTransportLocked) return;
      updateStreamPlayback({ transport: "http" });
      return;
    }
    setWebRtcCodecOverride(decision.codec);
  }, [
    configuredWebRtcCodec,
    effectiveWebRtcCodec,
    streamTransportLocked,
    updateStreamPlayback,
    wantsWebRtcVideo,
    webrtc.failure,
  ]);
  const lockedWebRtcError =
    streamTransportLocked && webrtc.failure && !webrtc.error
      ? "WebRTC streaming failed. HTTP fallback is disabled for this session."
      : null;
  // One-shot startup window; the JPEG seed paints immediately but only a
  // decoded H.264 frame proves AVCC is viable and cancels this fallback.
  useEffect(() => {
    if (!useAvccVideo) return;
    const timer = setTimeout(
      () => dispatchAvccFallback("timeout"),
      AVCC_FRAME_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [useAvccVideo, config.streamUrl]);
  const [liveStreamConfig, setLiveStreamConfig] = useState<StreamConfig | null>(null);
  // Screen config now arrives over the input WebSocket (pushed by the helper on
  // connect + on every dimension/orientation change) instead of a 1s /config poll.
  const [wsStreamConfig, setWsStreamConfig] = useState<StreamConfig | null>(null);
  const streamConfig = wsStreamConfig;
  const activeStreamConfig = liveStreamConfig ?? streamConfig ?? fallbackScreenSize(deviceType, deviceName);
  const imgBorderRadius = screenBorderRadius(deviceType, activeStreamConfig);
  const frameMaxWidth = simulatorMaxWidth(deviceType, activeStreamConfig);
  const frameAspectRatio = simulatorAspectRatio(activeStreamConfig);
  const frameDisplayConfig = displayStreamConfig(activeStreamConfig);
  const frameAspectRatioValue = frameDisplayConfig
    ? frameDisplayConfig.width / frameDisplayConfig.height
    : 1;

  // DeviceKit chrome wraps the live stream in the real device bezel (with
  // working hardware buttons). It's authored portrait, so in landscape we drop
  // back to the bare rounded screen. When chromed, the on-screen container is
  // the full frame (bezel + screen): `chromeScale` is how much bigger the frame
  // is than the screen, so we scale the container up by it while keeping the
  // *screen* at the same comfortable size — and resize / panel-collision math
  // all operate on the frame dimensions.
  const isLandscape = isLandscapeConfig(activeStreamConfig);
  const useChrome = !!chrome && !isLandscape && chromeEnabled;
  const chromeScale = useChrome ? chrome!.frame.width / chrome!.screen.width : 1;
  const containerDefaultWidth = frameMaxWidth * chromeScale;
  const containerAspectRatioValue = useChrome
    ? chrome!.frame.width / chrome!.frame.height
    : frameAspectRatioValue;
  const containerAspectRatio = useChrome
    ? `${chrome!.frame.width} / ${chrome!.frame.height}`
    : frameAspectRatio;

  // Touch/button relay via direct WebSocket
  const wsRef = useRef<WebSocket | null>(null);
  const pendingWsMessagesRef = useRef<QueuedWsMessage[]>([]);
  useEffect(() => {
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let currentWs: WebSocket | null = null;
    pendingWsMessagesRef.current = [];

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 1000);
    };

    const connect = () => {
      const ws = new WebSocket(config.wsUrl);
      ws.binaryType = "arraybuffer";
      currentWs = ws;
      wsRef.current = ws;
      ws.onopen = () => {
        pendingWsMessagesRef.current = flushWsMessageQueue(
          ws,
          pendingWsMessagesRef.current,
        );
      };
      ws.onmessage = (ev) => {
        // Server -> client screen-config push (tag 0x82): [tag][JSON].
        if (!(ev.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(ev.data);
        if (bytes.length < 1 || bytes[0] !== 0x82) return;
        try {
          const cfg = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as StreamConfig;
          if (cfg.width <= 0 || cfg.height <= 0) return;
          setWsStreamConfig((prev) =>
            prev &&
            prev.width === cfg.width &&
            prev.height === cfg.height &&
            prev.orientation === cfg.orientation
              ? prev
              : cfg,
          );
        } catch {}
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        scheduleReconnect();
      };
      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current === currentWs) wsRef.current = null;
      currentWs?.close();
    };
  }, [config.wsUrl]);

  // In WebRTC mode, HID prefers the data channels: they ride the media path
  // (UDP, no tunnel hops) instead of the tunneled TCP WebSocket. Gesture
  // boundaries, buttons and keys go on the reliable "input" channel; touch
  // moves, scroll and crown deltas on the lossy "moves" channel, where a lost
  // packet never stalls the ones behind it. begin/end are duplicated onto the
  // lossy lane so the common case lands fast, and every touch message carries
  // a gesture id + sequence so the server applies each once and in order. The
  // router pins each gesture to one transport (channels or socket) so the
  // socket cannot interleave with them; everything falls back to the
  // WebSocket whenever the input channel is not open.
  const inputRouterRef = useRef(new HidTransportRouter());
  const gestureStamperRef = useRef(new GestureStamper());
  const webRtcInputTarget = webrtc.inputTarget;
  const webRtcMovesTarget = webrtc.movesTarget;
  const sendWs = useCallback((tag: number, payload: object) => {
    const stamped = gestureStamperRef.current.stamp(tag, payload);
    const inputTarget = useWebRtcVideo ? webRtcInputTarget : null;
    const movesTarget = useWebRtcVideo ? webRtcMovesTarget : null;
    const dispatch = inputRouterRef.current.route(tag, stamped, inputTarget !== null, movesTarget !== null);
    if (dispatch.via === "socket" || !inputTarget) {
      pendingWsMessagesRef.current = sendOrQueueWsMessage(
        wsRef.current,
        pendingWsMessagesRef.current,
        tag,
        stamped,
      );
      return;
    }
    // Anything queued while the socket was down goes out on the reliable lane
    // first, so it still precedes this event.
    pendingWsMessagesRef.current = flushWsMessageQueue(inputTarget, pendingWsMessagesRef.current);
    const bytes = encodeWsMessage(tag, stamped).buffer;
    for (const lane of dispatch.lanes) {
      (lane === "moves" ? movesTarget : inputTarget)?.send(bytes);
    }
  }, [useWebRtcVideo, webRtcInputTarget, webRtcMovesTarget]);

  const onStreamTouch = useCallback(
    (data: { type: string; x: number; y: number; edge?: number }) => {
      sendWs(0x03, data);
    },
    [sendWs],
  );

  const onStreamMultiTouch = useCallback((data: any) => sendWs(0x05, data), [sendWs]);
  const onStreamButton = useCallback((button: string) => sendWs(0x04, { button }), [sendWs]);
  // A hardware button on the device chrome was pressed/released. Forward its HID
  // (page, usage) so the helper injects it via arbitrary HID — `down`/`up` phases
  // let power / side buttons be held for their long-press menus.
  const handleChromeButton = useCallback(
    ({ phase, button }: ChromeButtonPress) => {
      if (button.usagePage == null || button.usage == null) return;
      sendWs(0x04, {
        button: button.name,
        page: button.usagePage,
        usage: button.usage,
        phase,
      });
    },
    [sendWs],
  );
  const onStreamDigitalCrown = useCallback((delta: number) => sendWs(0x0a, { delta }), [sendWs]);
  const onStreamScroll = useCallback((data: { dx: number; dy: number; x: number; y: number }) => sendWs(0x0b, data), [sendWs]);
  const onScreenConfigChange = useCallback((next: StreamConfig) => {
    setLiveStreamConfig((prev) =>
      prev &&
      prev.width === next.width &&
      prev.height === next.height &&
      prev.orientation === next.orientation
        ? prev
        : next,
    );
  }, []);
  const rotateDevice = useCallback((orientation: SimulatorOrientation) => {
    sendWs(0x07, { orientation });
  }, [sendWs]);
  const currentOrientation =
    (activeStreamConfig as { orientation?: SimulatorOrientation }).orientation ?? "portrait";
  const canRotate = deviceType !== "watch" && deviceType !== "vision";
  const rotateBy = useCallback(
    (direction: "left" | "right") => {
      if (!canRotate) return;
      const next = (direction === "left" ? ROTATE_LEFT_CYCLE : ROTATE_RIGHT_CYCLE)[currentOrientation];
      rotateDevice(next);
    },
    [canRotate, currentOrientation, rotateDevice],
  );

  useEffect(() => {
    setLiveStreamConfig(null);
    setWsStreamConfig(null);
  }, [config.streamUrl]);

  useEffect(() => {
    const confirmedConfig = streamConfig;
    if (!confirmedConfig) return;
    setLiveStreamConfig((prev) =>
      prev &&
      prev.width === confirmedConfig.width &&
      prev.height === confirmedConfig.height &&
      prev.orientation === confirmedConfig.orientation
        ? prev
        : null,
    );
  }, [streamConfig, streamConfig?.width, streamConfig?.height, streamConfig?.orientation]);

  const sendKey = useCallback((type: "down" | "up", usage: number) => {
    sendWs(0x06, { type, usage });
  }, [sendWs]);

  // Subscribe to app-state SSE.
  const [currentApp, setCurrentApp] = useState<{ bundleId: string; isReactNative: boolean; pid?: number } | null>(null);
  // Start with the tools panel open when the viewport has room for it beside
  // the simulator (typical device frame ≈ 420px plus page/panel gutters);
  // smaller windows keep it closed so the device isn't squeezed on load.
  const [panelOpen, setPanelOpen] = useState(() => {
    if (typeof window === "undefined" || presentation) return false;
    const stored = Number(window.localStorage.getItem("serve-sim:tools-panel-width"));
    const panelWidth = Number.isFinite(stored) && stored > 0 ? stored : PANEL_WIDTH;
    return window.innerWidth >= panelWidth + 640;
  });
  const openPanelsRef = useRef({ panel: false, devtools: false });
  openPanelsRef.current = { panel: panelOpen, devtools: devtoolsOpen };
  const panelsBeforePresentationRef = useRef<{ panel: boolean; devtools: boolean } | null>(null);
  useEffect(() => {
    if (presentation) {
      panelsBeforePresentationRef.current ??= openPanelsRef.current;
      setPanelOpen(false);
      setDevtoolsOpen(false);
      return;
    }
    const restored = panelsBeforePresentationRef.current;
    if (!restored) return;
    panelsBeforePresentationRef.current = null;
    setPanelOpen(restored.panel);
    setDevtoolsOpen(restored.devtools);
  }, [presentation, setDevtoolsOpen]);
  const { width: toolsPanelWidth, onPointerDown: onToolsResize } = useResizableWidth(
    "serve-sim:tools-panel-width",
    PANEL_WIDTH,
    240,
    720,
  );
  const { width: devtoolsPanelWidth, onPointerDown: onDevtoolsResize } = useResizableWidth(
    "serve-sim:devtools-panel-width",
    DEVTOOLS_PANEL_WIDTH,
    420,
    1400,
  );
  const [viewportWidth, setViewportWidth] = useState(
    () => (typeof window !== "undefined" ? window.innerWidth : 0),
  );
  const [viewportHeight, setViewportHeight] = useState(
    () => (typeof window !== "undefined" ? window.innerHeight : 0),
  );
  useEffect(() => {
    const onResize = () => {
      setViewportWidth(window.innerWidth);
      setViewportHeight(window.innerHeight);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    const es = openHostEventStream(config.appStateEndpoint ?? simEndpoint("appstate"));
    let timer: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = (e) => {
      try {
        const next = JSON.parse(e.data) as { bundleId: string; pid?: number; isReactNative: boolean };
        if (timer) clearTimeout(timer);
        const delay = next?.isReactNative ? 0 : 600;
        timer = setTimeout(() => setCurrentApp(next), delay);
      } catch {}
    };
    return () => { if (timer) clearTimeout(timer); es.close(); };
  }, [config.appStateEndpoint]);

  // R to reload the RN/Expo bundle.
  // expo-go https://github.com/expo/expo/blob/f043020ffffd39fabb7684d52937d349f1ddc148/apps/expo-go/ios/Exponent/Kernel/DevSupport/EXKernelDevKeyCommands.m#L236
  // dev-client https://github.com/expo/expo/blob/f043020ffffd39fabb7684d52937d349f1ddc148/packages/expo-dev-menu/ios/Interceptors/DevMenuKeyCommandsInterceptor.swift#L46
  // react-native https://github.com/react/react-native/blob/c1652651c09506b8dda0b9515b5f0e5829220f0d/packages/react-native/React/Base/RCTKeyCommands.m#L69-L74
  const sendReactNativeReload = useCallback(async () => {
    const R = 0x15;
    sendKey("down", R);
    await new Promise((r) => setTimeout(r, 30));
    sendKey("up", R);
  }, [sendKey]);

  const simContainerRef = useRef<HTMLDivElement | null>(null);
  const [deviceRenderedWidth, setDeviceRenderedWidth] = useState(0);
  const [deviceRenderedHeight, setDeviceRenderedHeight] = useState(0);
  useEffect(() => {
    const el = simContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      setDeviceRenderedWidth(rect?.width ?? 0);
      setDeviceRenderedHeight(rect?.height ?? 0);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [simFocused, setSimFocused] = useState(true);
  const simFocusedRef = useRef(true);
  simFocusedRef.current = simFocused;
  const pressedKeysRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    // The device is the page, so clicking the exit control isn't a focus change;
    // treating it as one would force-release every held key.
    if (presentation) {
      setSimFocused(true);
      return;
    }
    const onPointerDown = (e: PointerEvent) => {
      const inside = !!simContainerRef.current?.contains(e.target as Node);
      setSimFocused(inside);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [presentation]);

  useEffect(() => {
    if (simFocused) return;
    const held = pressedKeysRef.current;
    if (held.size === 0) return;
    for (const usage of held) sendWs(0x06, { type: "up", usage });
    held.clear();
  }, [simFocused, sendWs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent, type: "down" | "up") => {
      if (!simFocusedRef.current) return;
      if (e.code === "KeyH" && e.metaKey && e.shiftKey) {
        e.preventDefault();
        if (type === "down" && !e.repeat) sendWs(0x04, { button: "home" });
        return;
      }
      if ((e.code === "ArrowLeft" || e.code === "ArrowRight") && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        e.preventDefault();
        if (type === "down" && !e.repeat) {
          rotateBy(e.code === "ArrowLeft" ? "left" : "right");
        }
        return;
      }
      if (e.code === "KeyA" && e.metaKey && e.shiftKey) {
        e.preventDefault();
        if (type === "down" && !e.repeat) {
          execOnHost(`xcrun simctl ui ${config.device} appearance`).then((r) => {
            const next = r.stdout.trim() === "dark" ? "light" : "dark";
            return execOnHost(`xcrun simctl ui ${config.device} appearance ${next}`);
          }).catch(() => {});
        }
        return;
      }
      if (e.code === "KeyK" && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        e.preventDefault();
        if (type === "down" && !e.repeat) sendWs(0x0c, {});
        return;
      }
      const usage = hidUsageForCode(e.code);
      if (usage == null) return;
      e.preventDefault();
      if (type === "down") pressedKeysRef.current.add(usage);
      else pressedKeysRef.current.delete(usage);
      sendWs(0x06, { type, usage });
    };
    const down = (e: KeyboardEvent) => onKey(e, "down");
    const up = (e: KeyboardEvent) => onKey(e, "up");
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [sendWs, config.device, rotateBy]);

  const uploads = useUploadToasts();
  const screenshot = useScreenshotToast(config.device);
  const mediaDrop = useMediaDrop({
    exec: execOnHost,
    udid: config.device,
    enabled: streaming,
    onUploadStart: uploads.add,
    onUploadProgress: uploads.setProgress,
    onUploadEnd: (id, ok, message) =>
      uploads.update(id, { status: ok ? "success" : "error", message }),
    onUnsupported: (file) => {
      const id = uploads.add(file.name, "media");
      uploads.update(id, {
        status: "error",
        message: `Unsupported: ${file.type || fileExtension(file)}`,
      });
    },
    onHostPathDrop: screenshot.dismiss,
  });

  const simulatorResize = useSimulatorResize({
    defaultWidth: containerDefaultWidth,
    viewportWidth,
    viewportHeight,
    aspectRatio: containerAspectRatioValue,
    onStart: () => setSimFocused(false),
  });

  // Only shift the simulator when a panel would otherwise collide with it.
  // Tools/DevTools dock on the right; the device sidebar docks on the left, so
  // each pushes the centered simulator the opposite way.
  const PANEL_EDGE_OFFSET = 12;
  const PANEL_GAP = 24;
  const RAIL_PANEL_GAP = 8;
  const SM_BREAKPOINT = 640;
  const deviceWidth = deviceRenderedWidth > 0
    ? Math.min(deviceRenderedWidth, simulatorResize.width)
    : simulatorResize.width;
  // Shift needed to clear a docked panel of `panelWidthPx` on the given side
  // without ever pushing the device under the opposite edge.
  const shiftToClear = (panelWidthPx: number): number => {
    if (panelWidthPx <= 0) return 0;
    const panelInnerEdge = viewportWidth - PANEL_EDGE_OFFSET - panelWidthPx;
    const deviceEdgeAtCenter = viewportWidth / 2 + deviceWidth / 2;
    const overlap = deviceEdgeAtCenter - (panelInnerEdge - PANEL_GAP);
    if (overlap <= 0) return 0;
    const shiftNeeded = 2 * overlap;
    return shiftNeeded <= panelWidthPx + PANEL_GAP ? shiftNeeded : 0;
  };
  const rightPanelWidthPx = devtoolsOpen
    ? devtoolsPanelWidth
    : panelOpen
    ? toolsPanelWidth
    : 0;
  const shiftForRightPanel = presentation ? 0 : shiftToClear(rightPanelWidthPx);
  const shiftForLeftPanel = presentation ? 0 : shiftToClear(gridOpen ? gridPanelWidth : 0);
  const presentationInset = SIMULATOR_RESIZE_VIEWPORT_INSET_FOR_PRESENTATION;
  const layoutWidth = simulatorResize.width;
  const layoutHeight =
    containerAspectRatioValue > 0
      ? roundToDevicePixel(layoutWidth / containerAspectRatioValue)
      : 0;
  const frameWidth = presentation
    ? getPresentationFrameWidth(
        viewportWidth,
        viewportHeight,
        containerAspectRatioValue,
        presentationInset,
      )
    : layoutWidth;
  const layoutScale =
    layoutWidth > 0 && frameWidth > 0 ? frameWidth / layoutWidth : 1;
  const resizing = simulatorResize.isResizing || simulatorResize.isInertia;
  // `scale(1)` is not `none`: it would make this the containing block for every
  // fixed descendant. The state only holds the transform past the exit so the
  // device eases back down; entering reads `presentation` directly, in the same
  // commit that strips the chrome.
  const [exitScaling, setExitScaling] = useState(false);
  useEffect(() => {
    if (presentation) {
      setExitScaling(true);
      return;
    }
    if (!exitScaling) return;
    const id = setTimeout(() => setExitScaling(false), SIMULATOR_RESIZE_PRESENTATION_TRANSITION_MS);
    return () => clearTimeout(id);
  }, [presentation, exitScaling]);
  const scaling = presentation || exitScaling;
  const layoutTransition = resizing
    ? SIMULATOR_RESIZE_DRAG_TRANSITION
    : SIMULATOR_RESIZE_LAYOUT_TRANSITION;

  return (
    <AxStateProvider endpoint={axOverlayEnabled ? config?.axEndpoint : undefined}>
    <div
      className={`flex flex-col items-center justify-center h-dvh bg-page font-system box-border ${presentation ? "gap-0" : "pt-16 pb-6 sm:py-6 gap-3"}`}
      style={{
        paddingTop: presentation ? presentationInset : undefined,
        paddingBottom: presentation ? presentationInset : undefined,
        paddingLeft: presentation ? presentationInset : 24 + shiftForLeftPanel,
        paddingRight: presentation ? presentationInset : 24 + shiftForRightPanel,
        transition: resizing ? "none" : SIMULATOR_RESIZE_PAGE_TRANSITION,
      }}
    >
      <div
        className={`flex flex-col items-center min-w-0 ${presentation ? "gap-0" : "gap-3"}`}
        style={{
          width: layoutWidth,
          transition: layoutTransition,
        }}
      >
        {!presentation && (
        <div className={`fixed sm:static top-[18px] sm:top-auto left-1/2 -translate-x-1/2 sm:translate-x-0 z-30 sm:z-auto self-center ${panelOpen || devtoolsOpen ? "max-sm:hidden" : ""}`}>
          <SimulatorToolbar
            exec={execOnHost}
            onRotate={rotateDevice}
            orientation={(activeStreamConfig as { orientation?: SimulatorOrientation }).orientation ?? null}
            deviceUdid={config.device}
            deviceName={deviceName}
            deviceRuntime={deviceRuntime}
            streaming={streaming}
            aria-label="Simulator status"
            style={{
              width: "auto",
              minWidth: 0,
              maxWidth: "100%",
              flexWrap: "nowrap",
              justifyContent: "center",
              gap: 10,
              padding: "6px 10px",
              borderRadius: 18,
            }}
          >
            <span className="hidden sm:contents">
              <SimulatorToolbar.Title
                onClick={() => setGridOpen((o) => !o)}
                aria-label="Toggle simulators sidebar"
                aria-pressed={gridOpen}
                title="Simulators"
                hideSubtitle
                hideChevron
                style={{
                  maxWidth: "min(230px, calc(100vw - 170px))",
                }}
              />
            </span>
            <StreamStatusPill streaming={streaming} />
          </SimulatorToolbar>
        </div>
        )}
        {presentation && !embedLocked && (
          <PresentationControls onExit={onExitPresentation} />
        )}
        <div
          ref={simContainerRef}
          className="relative max-h-full"
          style={{
            width: layoutWidth,
            height: layoutHeight > 0 ? layoutHeight : undefined,
            aspectRatio: containerAspectRatio,
            transform: scaling ? `scale(${layoutScale})` : undefined,
            transformOrigin: "center center",
            transition: resizing
              ? SIMULATOR_RESIZE_DRAG_TRANSITION
              : `${SIMULATOR_RESIZE_LAYOUT_TRANSITION}, ${SIMULATOR_RESIZE_PRESENTATION_TRANSITION}`,
            willChange: resizing ? "width" : scaling ? "transform" : undefined,
          }}
          {...mediaDrop.dropZoneProps}
        >
          {(() => {
            const streamView = (
              <SimulatorView
                url={config.url}
                wsUrl={config.wsUrl}
                style={{
                  width: "100%",
                  height: "100%",
                  border: "none",
                  pointerEvents:
                    simulatorResize.isResizing || simulatorResize.isInertia ? "none" : undefined,
                }}
                imageStyle={{
                  // With chrome the screen slot clips (rounded) and the bezel
                  // provides the edge, so the stream itself is square + flush.
                  // Without chrome, round the screen and add a subtle bezel as an
                  // INSET shadow (not a border): a 1px border sits outside the
                  // content and, on the <canvas> path, composites its
                  // semi-transparent white against the black page as a visible
                  // outline. An inset shadow paints over the (opaque) video edge.
                  borderRadius: useChrome ? 0 : imgBorderRadius,
                  cornerShape: useChrome ? undefined : "superellipse(1.3)",
                  ...(useChrome
                    ? {}
                    : { boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.2)" }),
                } as CSSProperties}
                hideControls
                onStreamingChange={setStreaming}
                onStreamTouch={onStreamTouch}
                onStreamMultiTouch={onStreamMultiTouch}
                onStreamButton={onStreamButton}
                onStreamDigitalCrown={onStreamDigitalCrown}
                onStreamScroll={onStreamScroll}
                streamMode={useWebRtcVideo ? "webrtc" : useAvccVideo ? "avcc" : "mjpeg"}
                webRtcStream={webrtc.stream}
                onWebRtcFrame={webrtc.markFrameDecoded}
                streamError={useWebRtcVideo ? webrtc.error ?? lockedWebRtcError : null}
                onAvccError={() => dispatchAvccFallback("error")}
                onAvccDecodedFrame={() => dispatchAvccFallback("decoded-frame")}
                subscribeFrame={useAvccVideo ? undefined : mjpeg.subscribeFrame}
                streamFrame={useAvccVideo ? undefined : mjpeg.frame}
                streamConfig={activeStreamConfig}
                enableDigitalCrown={deviceType === "watch"}
                onScreenConfigChange={onScreenConfigChange}
              />
            );
            const screenContent = (
              <>
                {streamView}
                {axOverlayEnabled && !presentation && <AxDomOverlay />}
              </>
            );
            if (!useChrome) return screenContent;
            // The screen slot is the bezel's true opening; the stream letterboxes
            // (contains) inside it, filling the constraining axis and leaving a
            // thin black margin on the other — the device's own black screen
            // border. Containing (not covering) keeps the stream from ever
            // overflowing past the bezel.
            return (
              <DeviceKitChrome
                chrome={chrome!}
                interactive
                containerSize={
                  // Measured, not computed: pixel rects can't self-correct the
                  // way the percentage layout did.
                  deviceRenderedWidth > 0 && deviceRenderedHeight > 0
                    ? { width: deviceRenderedWidth, height: deviceRenderedHeight }
                    : undefined
                }
                onButton={handleChromeButton}
                onCrownWheel={(deltaY, deltaMode) => {
                  const delta = digitalCrownDeltaFromWheel(
                    deltaY,
                    deltaMode,
                    deviceRenderedHeight || 1,
                  );
                  if (delta != null) onStreamDigitalCrown(delta);
                }}
                screen={screenContent}
              />
            );
          })()}
          {mediaDrop.isDragOver && (
            <div
              // No backdrop-blur here: the canvas underneath repaints every
              // stream frame, and backdrop-filter forces a full re-blur per
              // frame for the whole drag — the tint alone stays cheap.
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-accent bg-[rgba(99,102,241,0.18)] text-accent pointer-events-none z-20"
              style={{ borderRadius: useChrome ? undefined : imgBorderRadius }}
            >
              <Upload size={32} strokeWidth={1.5} />
              <span className="text-[13px] font-medium">Drop media or .ipa</span>
            </div>
          )}
          {!presentation && viewportWidth >= SM_BREAKPOINT && (
            <SimulatorResizeCornerHandle
              simulatorResize={simulatorResize}
              deviceType={deviceType}
              streamConfig={activeStreamConfig}
              containerWidth={deviceRenderedWidth || simulatorResize.width}
              containerHeight={
                deviceRenderedHeight ||
                (containerAspectRatioValue > 0 ? simulatorResize.width / containerAspectRatioValue : 0)
              }
            />
          )}
          <SimulatorResizeSizeBadge
            width={deviceRenderedWidth || simulatorResize.width}
            height={
              deviceRenderedHeight ||
              (containerAspectRatioValue > 0 ? simulatorResize.width / containerAspectRatioValue : 0)
            }
            visible={!presentation && (simulatorResize.isResizing || simulatorResize.isInertia)}
          />
        </div>
        {!presentation && (
        <div className="inline-flex items-center justify-center gap-2 max-w-full pb-1 sm:pb-0">
          <SimulatorToolbar
            exec={execOnHost}
            onRotate={rotateDevice}
            orientation={(activeStreamConfig as { orientation?: SimulatorOrientation }).orientation ?? null}
            deviceUdid={config.device}
            deviceName={deviceName}
            deviceRuntime={deviceRuntime}
            streaming={streaming}
            aria-label="Simulator actions"
            style={{
              alignSelf: "center",
              width: "auto",
              minWidth: 0,
              maxWidth: "100%",
              justifyContent: "center",
              padding: "6px 8px",
              borderRadius: 18,
            }}
          >
            <SimulatorToolbar.Actions>
              {currentApp?.isReactNative && (
                <SimulatorToolbar.Button
                  aria-label="Reload React Native bundle"
                  title="Reload (R)"
                  onClick={() => void sendReactNativeReload()}
                >
                  <ReloadIcon />
                </SimulatorToolbar.Button>
              )}
              <SimulatorToolbar.HomeButton title="Home" />
              <SimulatorToolbar.ScreenshotButton
                title="Screenshot"
                onClick={(e) => { e.preventDefault(); void screenshot.capture(); }}
              />
              <SimulatorToolbar.RotateButton title="Rotate device" />
            </SimulatorToolbar.Actions>
          </SimulatorToolbar>
          <SimulatorToolbar
            exec={execOnHost}
            onRotate={rotateDevice}
            orientation={(activeStreamConfig as { orientation?: SimulatorOrientation }).orientation ?? null}
            deviceUdid={config.device}
            deviceName={deviceName}
            deviceRuntime={deviceRuntime}
            streaming={streaming}
            aria-label="Accessibility overlay"
            style={{
              width: "auto",
              minWidth: 0,
              justifyContent: "center",
              padding: 6,
              borderRadius: 22,
            }}
          >
            <AxToolbarButton
              overlayEnabled={axOverlayEnabled}
              streaming={streaming}
              onToggleOverlay={() => setAxOverlayEnabled((enabled) => !enabled)}
            />
          </SimulatorToolbar>
        </div>
        )}
      </div>

      {!presentation && (
      <>
      <div
        className="fixed top-3 flex flex-row sm:flex-col gap-1 p-1 bg-panel-bg border border-white/8 rounded-[10px] backdrop-blur-[12px] [-webkit-backdrop-filter:blur(12px)] [transition:right_0.24s_cubic-bezier(0.22,1,0.36,1)] z-30"
        style={{
          right:
            PANEL_EDGE_OFFSET +
            ((panelOpen || devtoolsOpen) && viewportWidth >= SM_BREAKPOINT
              ? rightPanelWidthPx + RAIL_PANEL_GAP
              : 0),
        }}
      >
        <IconButton
          onClick={onEnterPresentation}
          aria-label="Full screen"
          title="Full screen"
        >
          <Maximize2 size={18} strokeWidth={1.75} />
        </IconButton>
        <IconButton
          onClick={() => {
            setDevtoolsOpen(false);
            setPanelOpen((o) => !o);
          }}
          aria-label="Open tools panel"
          aria-pressed={panelOpen}
          title="Tools"
        >
          <PanelRight size={18} strokeWidth={1.75} />
        </IconButton>
        <IconButton
          onClick={() => {
            setPanelOpen(false);
            setDevtoolsOpen((o) => !o);
          }}
          className="max-sm:hidden"
          aria-label="Open WebKit DevTools"
          aria-pressed={devtoolsOpen}
          title="WebKit DevTools"
        >
          <Globe size={18} strokeWidth={1.75} />
        </IconButton>
      </div>

      <ToolsPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        udid={config.device}
        deviceRuntime={deviceRuntime}
        currentApp={currentApp}
        eventLogEventsEndpoint={config.eventLogEventsEndpoint}
        metricsEndpoint={config.metricsEndpoint}
        axOverlayEnabled={axOverlayEnabled}
        onToggleAxOverlay={() => setAxOverlayEnabled((enabled) => !enabled)}
        streamSettings={streamSettings}
        onStreamPlaybackSettingsChange={streamSettingsState.updatePlayback}
        onStreamEncoderSettingsChange={streamSettingsState.updateEncoder}
        activeCodec={useWebRtcVideo ? `webrtc/${effectiveWebRtcCodec}` : useAvccVideo ? "h264" : "mjpeg"}
        peerConnection={webrtc.peerConnection}
        webrtcSessionId={webrtc.sessionId}
        webrtcStatsUrl={webrtcStatsUrlFrom(config)}
        avccSupported={avcc.supported}
        streamSettingsPending={
          streamSettingsState.pending || !streamSettingsState.encoderSettingsAvailable
        }
        streamTransportLocked={streamTransportLocked}
        width={toolsPanelWidth}
        chromeEnabled={chromeEnabled}
        onChromeEnabledChange={setChromeEnabled}
        hasChrome={!!chrome && !isLandscape}
      />
      <ResizeHandle
        panelWidth={toolsPanelWidth}
        visible={panelOpen}
        onPointerDown={onToolsResize}
        ariaLabel="Resize tools panel"
      />

      <WebKitDevtoolsPanel
        open={devtoolsOpen}
        onClose={() => setDevtoolsOpen(false)}
        udid={config.device}
        targets={devtools.targets}
        selectedTargetId={selectedDevtoolsTargetId}
        onSelectTarget={setSelectedDevtoolsTargetId}
        loading={devtools.loading}
        error={devtools.error}
        onRefresh={() => void devtools.refresh()}
        width={devtoolsPanelWidth}
      />
      <ResizeHandle
        panelWidth={devtoolsPanelWidth}
        visible={devtoolsOpen}
        onPointerDown={onDevtoolsResize}
        ariaLabel="Resize WebKit DevTools panel"
      />
      </>
      )}
    </div>
    </AxStateProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
