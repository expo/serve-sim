import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { FlipHorizontal2, Images, X } from "lucide-react";
import { PlayGlyph, StopGlyph, ReloadIcon } from "../icons";
import { runHostAction, stopCameraFrames } from "../utils/exec";
import { fileExtension, uploadFileToTmp } from "../utils/drop";
import {
  BROWSER_CAMERA_UNSUPPORTED,
  type BrowserCameraSession,
  browserCameraErrorMessage,
  browserCameraSupported,
  startBrowserCamera,
} from "../utils/browser-camera";
import { CollapsibleSection } from "./collapsible-section";

import {
  isVideoFile,
  type CamSource,
  type CamWebcam,
  type CameraPillState,
  CAMERA_POLL_INTERVAL_MS,
  requestCameraStatus,
  CAMERA_LARGE_VIDEO_WARNING,
  CAMERA_HEIC_ERROR,
  nextCameraPillState,
  parseWebcamListOutput,
  isOversizedCameraVideo,
  isHeicLikeFile,
  cameraSourceErrorMessage,
} from "../utils/camera";
import { type CameraMediaPreviewProps, CameraStatusPill, CameraMediaPreview, CameraInlineBanner } from "./camera-tool-ui";

type CamMirror = "on" | "off";

export function CameraTool({
  udid,
}: {
  udid: string;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<CamSource>("placeholder");
  const [filePath, setFilePath] = useState<string>("");
  const [droppedFileName, setDroppedFileName] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCountRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [webcams, setWebcams] = useState<CamWebcam[]>([]);
  const [webcamLoading, setWebcamLoading] = useState(false);
  const [webcamId, setWebcamId] = useState<string>("");
  const [mirror, setMirror] = useState<CamMirror>("off");
  const [pendingPrimary, setPendingPrimary] = useState<"enable" | "disable" | null>(null);
  const [pendingAux, setPendingAux] = useState<"mirror" | "switch" | null>(null);
  const isBusy = pendingPrimary !== null || pendingAux !== null;
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [pillState, setPillState] = useState<CameraPillState>("ready");
  const lastFileIsHeicRef = useRef(false);

  const [browserLabel, setBrowserLabel] = useState<string | null>(null);
  const browserSessionRef = useRef<BrowserCameraSession | null>(null);
  const browserAbortRef = useRef<AbortController | null>(null);
  const operationRef = useRef(0);
  const browserOwnsHelperRef = useRef(false);
  const enablingRef = useRef(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const appliedSourceRef = useRef<string | null>(null);
  const commandsRef = useRef<Promise<unknown>>(Promise.resolve());

  const cameraAction = useCallback((action: string, params: Record<string, string | undefined> = {}) => {
    const command = commandsRef.current.then(() => runHostAction(action, { ...params, udid }));
    commandsRef.current = command.catch(() => {});
    return command;
  }, [udid]);

  const stopBrowserCamera = useCallback(() => {
    browserAbortRef.current?.abort();
    browserAbortRef.current = null;
    browserSessionRef.current?.stop();
    browserSessionRef.current = null;
    browserOwnsHelperRef.current = false;
    if (mountedRef.current) setBrowserLabel(null);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const release = () => {
      operationRef.current++;
      const ownedBrowser = browserOwnsHelperRef.current;
      stopBrowserCamera();
      busyRef.current = false;
      enablingRef.current = false;
      if (mountedRef.current) {
        setPendingPrimary(null);
        setPendingAux(null);
        if (ownedBrowser) {
          setEnabled(false);
          setPillState("ready");
        }
      }
      if (ownedBrowser) void commandsRef.current.then(() => stopCameraFrames(udid));
    };
    window.addEventListener("pagehide", release);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [stopBrowserCamera, udid]);

  const fetchCameraStatus = useCallback(async () => {
    const endpoint = window.__SIM_PREVIEW__?.cameraStatusEndpoint;
    return endpoint ? requestCameraStatus(endpoint) : null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let initial = true;
    const tick = async () => {
      if (cancelled || inFlight || busyRef.current || document.visibilityState === "hidden") return;
      const generation = operationRef.current;
      inFlight = true;
      try {
        const reply = await fetchCameraStatus();
        if (cancelled || generation !== operationRef.current || busyRef.current || !reply) return;
        if (initial && generation === 0 && reply.alive) {
          const restored = reply.source === "stream" ? "browser" : reply.source;
          if (restored === "placeholder" || restored === "webcam" || restored === "image" || restored === "video" || restored === "browser") {
            setSource(restored);
            const path = restored === "image" || restored === "video" ? reply.arg ?? "" : "";
            const webcam = restored === "webcam" ? reply.arg ?? "" : "";
            setFilePath(path);
            setDroppedFileName(path ? path.split("/").pop() ?? null : null);
            setWebcamId(webcam);
            appliedSourceRef.current = `${restored}::${webcam}::${path}`;
            if (restored === "browser") setWarning("This tab is not sending camera frames. Pick Browser camera to connect it.");
          }
          const restoredMirror = reply.mirror === "on" ? "on" : "off";
          setMirror(restoredMirror);
        }
        initial = false;
        const alive = reply.alive === true;
        const connected = alive && (reply.connected ?? true);
        setPillState((previous) => nextCameraPillState(previous, connected));
        setEnabled(alive);
        if (!alive) {
          stopBrowserCamera();
        } else if (browserSessionRef.current && typeof reply.source === "string" && reply.source !== "stream") {
          stopBrowserCamera();
          setWarning("The camera source changed in another session. Pick Browser camera to reconnect this tab.");
        }
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, CAMERA_POLL_INTERVAL_MS);
    const onVisibility = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchCameraStatus, stopBrowserCamera, udid]);

  const refreshWebcams = useCallback(async () => {
    setWebcamLoading(true);
    setError(null);
    try {
      const res = await runHostAction("camera.listWebcams");
      if (!mountedRef.current) return;
      if (res.exitCode !== 0) {
        setError(res.stderr.trim() || `Could not list host cameras (${res.exitCode})`);
        return;
      }
      const list = parseWebcamListOutput(res.stdout);
      setWebcams(list);
      if (list.length > 0) setWebcamId((current) => current || list[0]!.id);
    } catch (error) {
      if (mountedRef.current) setError(browserCameraErrorMessage(error));
    } finally {
      if (mountedRef.current) setWebcamLoading(false);
    }
  }, []);

  const sourceKey = `${source}::${source === "webcam" ? webcamId : ""}::${source === "image" || source === "video" ? filePath : ""}`;

  const applySource = useCallback(async (enable: boolean) => {
    const generation = ++operationRef.current;
    busyRef.current = true;
    enablingRef.current = enable;
    if (enable) setPendingPrimary("enable");
    else setPendingAux("switch");
    appliedSourceRef.current = sourceKey;
    stopBrowserCamera();
    setError(null);
    setWarning(null);
    const current = () => mountedRef.current && generation === operationRef.current;
    try {
      const isFile = source === "image" || source === "video";
      if (isFile && !filePath.trim()) throw new Error("Drop a file into the panel or pick another source.");
      if (source === "browser") {
        const controller = new AbortController();
        browserAbortRef.current = controller;
        const session = await startBrowserCamera({
          udid,
          signal: controller.signal,
          onError(message) {
            if (!mountedRef.current || browserAbortRef.current !== controller) return;
            operationRef.current++;
            const ownedHelper = browserOwnsHelperRef.current;
            stopBrowserCamera();
            busyRef.current = false;
            setPendingPrimary(null);
            setPendingAux(null);
            setEnabled(false);
            setPillState("disconnected");
            setError(message);
            if (ownedHelper) void commandsRef.current.then(() => stopCameraFrames(udid));
          },
        });
        if (!current()) { session.stop(); return; }
        browserSessionRef.current = session;
        setBrowserLabel(session.label);
      }
      if (!current()) return;
      browserOwnsHelperRef.current = source === "browser";
      const res = await cameraAction(enable ? "camera.inject" : "camera.switch", {
        source: isFile ? "file" : source === "browser" ? "stream" : source,
        target: isFile ? filePath.trim() : source === "webcam" ? webcamId || undefined : undefined,
        ...(enable ? { mirror } : {}),
      });
      if (!current()) return;
      if (res.exitCode !== 0) throw new Error(res.stderr.trim() || res.stdout.trim() || `Could not update camera (${res.exitCode})`);
      lastFileIsHeicRef.current = false;
      setEnabled(true);
      setPillState(source === "browser" ? "ready" : "active");
      browserSessionRef.current?.start();
    } catch (error) {
      if (!current()) return;
      stopBrowserCamera();
      setError(cameraSourceErrorMessage({ rawMessage: browserCameraErrorMessage(error), lastFileIsHeic: lastFileIsHeicRef.current, source }));
    } finally {
      if (current()) {
        enablingRef.current = false;
        busyRef.current = false;
        setPendingPrimary(null);
        setPendingAux(null);
      }
    }
  }, [cameraAction, filePath, mirror, source, sourceKey, stopBrowserCamera, udid, webcamId]);

  const enableCamera = useCallback(() => applySource(true), [applySource]);
  useEffect(() => {
    if (!enabled || appliedSourceRef.current === sourceKey) return;
    void applySource(false);
  }, [enabled, sourceKey, applySource]);

  const isStreaming = enabled && source !== "placeholder";
  useEffect(() => {
    if (isStreaming) setOpen(true);
  }, [isStreaming]);

  const disableCamera = useCallback(async () => {
    const generation = ++operationRef.current;
    busyRef.current = true;
    stopBrowserCamera();
    setPendingPrimary("disable");
    setPendingAux(null);
    setError(null);
    try {
      const res = await cameraAction("camera.stopWebcam");
      if (!mountedRef.current || generation !== operationRef.current) return;
      if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `Could not disable camera (${res.exitCode})`);
      setEnabled(false);
      setPillState("ready");
    } catch (error) {
      if (mountedRef.current && generation === operationRef.current) setError(browserCameraErrorMessage(error));
    } finally {
      if (mountedRef.current && generation === operationRef.current) {
        busyRef.current = false;
        setPendingPrimary(null);
      }
    }
  }, [cameraAction, stopBrowserCamera]);

  const cancelBrowserRequest = useCallback(() => {
    if (!browserAbortRef.current) return;
    operationRef.current++;
    const stopPendingEnable = enablingRef.current && browserOwnsHelperRef.current;
    stopBrowserCamera();
    enablingRef.current = false;
    busyRef.current = false;
    setPendingPrimary(null);
    setPendingAux(null);
    if (stopPendingEnable) void commandsRef.current.then(() => stopCameraFrames(udid));
  }, [stopBrowserCamera, udid]);

  const handleSourceFile = useCallback(async (file: File) => {
    const isHeic = isHeicLikeFile({ type: file.type, name: file.name });
    const isImage = file.type.startsWith("image/") || isHeic;
    const isVideo = file.type.startsWith("video/") || isVideoFile({ type: file.type, name: file.name });
    if (!isImage && !isVideo) {
      lastFileIsHeicRef.current = false;
      setError(`Unsupported file type: ${file.type || file.name}`);
      return;
    }
    setUploading(true);
    setError(null);
    setWarning(null);
    if (isOversizedCameraVideo({ type: file.type, name: file.name, size: file.size })) {
      setWarning(CAMERA_LARGE_VIDEO_WARNING);
    }
    lastFileIsHeicRef.current = isHeic;
    try {
      const ext = fileExtension(file);
      const tmpPath = await uploadFileToTmp(file, "serve-sim-camsrc", ext);
      if (!mountedRef.current) return;
      cancelBrowserRequest();
      setDroppedFileName(file.name);
      setSource(isVideo ? "video" : "image");
      setFilePath(tmpPath);
    } catch (error) {
      if (lastFileIsHeicRef.current) setError(CAMERA_HEIC_ERROR);
      else setError(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [cancelBrowserRequest]);

  const onDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current = 0;
    setIsDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) await handleSourceFile(file);
  }, [handleSourceFile]);

  const clearMedia = useCallback(() => {
    cancelBrowserRequest();
    setSource("placeholder");
    setFilePath("");
    setDroppedFileName(null);
    setError(null);
    setWarning(null);
    lastFileIsHeicRef.current = false;
  }, [cancelBrowserRequest]);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFilePicked = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (file) await handleSourceFile(file);
  }, [handleSourceFile]);

  useEffect(() => {
    if (!sourceMenuOpen) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest("[data-camera-source-menu]")) return;
      setSourceMenuOpen(false);
    };
    window.addEventListener("mousedown", onDocDown);
    return () => window.removeEventListener("mousedown", onDocDown);
  }, [sourceMenuOpen]);

  const selectWebcam = useCallback((webcam: CamWebcam) => {
    cancelBrowserRequest();
    setWebcamId(webcam.id);
    setSource("webcam");
    setDroppedFileName(null);
    setError(null);
    lastFileIsHeicRef.current = false;
    setSourceMenuOpen(false);
  }, [cancelBrowserRequest]);

  const selectBrowserCamera = useCallback(() => {
    setSourceMenuOpen(false);
    if (!browserCameraSupported()) { setError(BROWSER_CAMERA_UNSUPPORTED); return; }
    setDroppedFileName(null);
    lastFileIsHeicRef.current = false;
    setSource("browser");
    if (source === "browser") void applySource(!enabled);
  }, [source, enabled, applySource]);

  const toggleMirror = useCallback(async () => {
    const generation = ++operationRef.current;
    busyRef.current = true;
    const next = mirror === "on" ? "off" : "on";
    setPendingAux("mirror");
    setError(null);
    try {
      const res = await cameraAction("camera.mirror", { value: next });
      if (!mountedRef.current || generation !== operationRef.current) return;
      if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `Could not change mirror (${res.exitCode})`);
      setMirror(next);
    } catch (error) {
      if (mountedRef.current && generation === operationRef.current) setError(browserCameraErrorMessage(error));
    } finally {
      if (mountedRef.current && generation === operationRef.current) {
        busyRef.current = false;
        setPendingAux(null);
      }
    }
  }, [cameraAction, mirror]);
  const mirrorDisabled = !enabled || source === "placeholder" || isBusy;

  const onDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCountRef.current++;
    if (dragCountRef.current === 1) setIsDragOver(true);
  }, []);
  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }, []);
  const onDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCountRef.current--;
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const canCancelEnable = pendingPrimary === "enable" && source === "browser";
  const primaryDisabled = uploading || pendingPrimary === "disable" || (pendingPrimary === "enable" && !canCancelEnable);

  const isPlaceholder = source === "placeholder";
  const showWebcam = source === "webcam";
  const showBrowser = source === "browser";
  const showFile = (source === "image" || source === "video") && !!droppedFileName;
  const activeWebcamName = showWebcam
    ? (webcams.find((w) => w.id === webcamId)?.name ?? webcamId ?? "Webcam")
    : null;
  const tileMode: CameraMediaPreviewProps["mode"] = uploading
    ? "uploading"
    : showFile
      ? "file"
      : showBrowser ? "browser" : showWebcam ? "webcam" : "placeholder";

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      bodyClassName="pt-2.5"
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">Camera</span>
          <CameraStatusPill state={pillState} />
        </>
      }
    >
      <div
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className="flex flex-col gap-2.5"
      >
          <p className="m-0 text-[10px] leading-[1.5] text-white/45">
            Choose an image, video, or camera, then enable it for all apps.
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            className="hidden"
            onChange={onFilePicked}
          />

          <div
            onClick={(e) => {
              if (!isPlaceholder) return;
              if ((e.target as HTMLElement).closest("[data-clear-media]")) return;
              openFilePicker();
            }}
            title={
              isPlaceholder
                ? "No source selected — Enable uses a test-pattern feed. Click to pick an image/video, or drop one here."
                : showBrowser ? `Source: ${browserLabel ?? "this browser’s camera"}` : showWebcam
                  ? `Source: ${activeWebcamName}`
                  : `Source: ${droppedFileName ?? source}`
            }
            className={[
              "relative min-h-[44px] flex flex-row items-center justify-center gap-2.5 px-3.5 py-2.5 rounded-[7px] text-center transition-[border-color,background] duration-150",
              isPlaceholder
                ? "bg-white/[0.04] border border-dashed border-white/12"
                : "bg-white/[0.04] border border-white/8",
              isDragOver ? "!bg-[rgba(10,132,255,0.08)] !border-[rgba(10,132,255,0.6)]" : "",
              uploading ? "cursor-progress" : isPlaceholder ? "cursor-pointer" : "cursor-default",
            ].join(" ")}
          >
            <CameraMediaPreview
              mode={tileMode}
              fileName={droppedFileName}
              webcamName={showBrowser ? browserLabel ?? "This browser’s camera" : activeWebcamName}
              sourceKind={source}
            />

            {!isPlaceholder && !uploading && (
              <button
                data-clear-media
                onClick={(e) => { e.stopPropagation(); clearMedia(); }}
                className="shrink-0 w-5 h-5 flex items-center justify-center bg-transparent border-none text-white/55 hover:text-white/90 cursor-pointer p-0"
                aria-label="Clear source"
                title="Clear → placeholder"
              >
                <X size={14} strokeWidth={2} />
              </button>
            )}
          </div>


          <div className="flex items-stretch gap-1.5">
            <div className="relative" data-camera-source-menu>
              <button
                onClick={() => {
                  if (!sourceMenuOpen && !webcamLoading) void refreshWebcams();
                  setSourceMenuOpen((value) => !value);
                }}
                disabled={isBusy}
                className="h-full min-h-[36px] w-10 flex items-center justify-center bg-transparent border border-white/12 text-white/85 rounded-[7px] cursor-pointer p-0 hover:bg-white/[0.06] hover:border-white/20 hover:text-white"
                aria-haspopup="menu"
                aria-expanded={sourceMenuOpen}
                title={
                  source === "webcam"
                    ? `Source: webcam${webcamId ? ` (${webcams.find((w) => w.id === webcamId)?.name ?? webcamId})` : ""} — click to change`
                    : `Source: ${source} — click to pick media or webcam`
                }
                aria-label="Choose camera source"
              >
                <Images size={20} strokeWidth={2} />
              </button>

              {sourceMenuOpen && (
                <div
                  role="menu"
                  className="absolute top-[calc(100%+6px)] left-0 z-10 min-w-[200px] flex flex-col gap-px p-1 bg-panel border border-white/8 rounded-[7px] shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
                >
                  <button
                    role="menuitem"
                    className="text-left bg-transparent border-none text-white/85 text-[12px] px-2.5 py-[7px] rounded-md cursor-pointer hover:bg-white/[0.06]"
                    onClick={() => { setSourceMenuOpen(false); openFilePicker(); }}
                    title="Pick an image or video from disk"
                  >
                    Browse media…
                  </button>
                  <button
                    role="menuitem"
                    data-camera-browser-source
                    className="text-left bg-transparent border-none text-white/85 text-[12px] px-2.5 py-[7px] rounded-md cursor-pointer hover:bg-white/[0.06]"
                    onClick={selectBrowserCamera}
                  >
                    Browser camera
                  </button>
                  <div className="h-px bg-white/8 my-1" />
                  <div className="flex items-center justify-between pl-2.5 pr-2 pt-1 pb-[2px]">
                    <span className="text-[10px] text-white/45 uppercase tracking-[0.08em]">
                      {webcamLoading ? "Host cameras (loading…)" : webcams.length === 0 ? "No host cameras" : "Host cameras"}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); void refreshWebcams(); }}
                      disabled={webcamLoading}
                      className="flex items-center justify-center w-[22px] h-[22px] bg-transparent border-none rounded-[5px] text-white/55 hover:text-white/90 cursor-pointer p-0 disabled:opacity-50"
                      aria-label="Refresh cameras"
                      title="Refresh cameras"
                    >
                      <ReloadIcon size={13} strokeWidth={2} />
                    </button>
                  </div>
                  {webcams.map((w) => {
                    const active = source === "webcam" && webcamId === w.id;
                    return (
                      <button
                        key={w.id}
                        role="menuitem"
                        className={[
                          "text-left bg-transparent border-none text-[12px] px-2.5 py-[7px] rounded-md cursor-pointer hover:bg-white/[0.06]",
                          active ? "!bg-white/[0.12] !text-white" : "text-white/85",
                        ].join(" ")}
                        onClick={() => selectWebcam(w)}
                        title={w.name}
                      >
                        {w.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <button
              onClick={canCancelEnable ? cancelBrowserRequest : enabled ? disableCamera : enableCamera}
              disabled={primaryDisabled}
              className={[
                "flex-1 flex items-center justify-center gap-1.5 py-2 px-2.5 border-none rounded-[7px] text-[12px] font-semibold cursor-pointer disabled:opacity-50 min-h-[36px]",
                enabled
                  ? "bg-white/[0.16] text-white enabled:hover:bg-white/[0.22]"
                  : "bg-success-emerald text-[#062018] enabled:hover:brightness-[1.08]",
              ].join(" ")}
              title={
                enabled ? "Disconnect the camera from all apps" :
                "Enable the selected camera feed for all apps"
              }
              aria-pressed={enabled}
              aria-label={canCancelEnable ? "Cancel" : enabled ? "Disable" : "Enable"}
            >
              {enabled ? <StopGlyph /> : <PlayGlyph />}
              <span>{canCancelEnable ? "Cancel" : pendingPrimary === "enable" ? "Enabling…" : pendingPrimary === "disable" ? "Disabling…" : enabled ? "Disable" : "Enable"}</span>
            </button>

            <button
              type="button"
              onClick={toggleMirror}
              disabled={mirrorDisabled}
              className={`flex items-center justify-center w-10 min-h-[36px] border rounded-[7px] font-[inherit] disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97] ${
                mirror === "on"
                  ? "bg-white border-white text-[#0a0a0c] cursor-pointer enabled:hover:bg-white/[0.88] enabled:hover:border-white/[0.88] enabled:hover:text-[#0a0a0c]"
                  : "bg-white/[0.04] border-white/8 text-white/85 cursor-pointer enabled:hover:bg-white/[0.09] enabled:hover:border-[rgba(255,255,255,0.18)] enabled:hover:text-white"
              }`}
              aria-label={`Mirror: ${mirror} — tap to toggle`}
              title={
                mirrorDisabled
                  ? "Mirror toggle available once a source is streaming"
                  : `Mirror: ${mirror} — click to toggle`
              }
              aria-pressed={mirror === "on"}
            >
              <FlipHorizontal2 size={20} strokeWidth={2} fill={mirror === "on" ? "currentColor" : "none"} />
            </button>
          </div>

          {warning && <CameraInlineBanner kind="warning" message={warning} />}
          {error && <CameraInlineBanner kind="error" message={error} />}
        </div>
    </CollapsibleSection>
  );
}
