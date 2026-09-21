import { useEffect, useRef, useState, type ReactNode } from "react";
import { Power, Volume1, Volume2 } from "lucide-react";
import type { HingePose } from "../../hinge-control";
import type { StreamConfig } from "../types";
import { createDuoScene, type DuoSceneState } from "../simulator/duo-scene";
import { DuoHingeHandle } from "./duo-hinge-handle";
import type { DuoHingeCommands } from "../simulator/duo-hinge-commands";
import type { DuoControlChrome } from "../simulator/duo-device-controls";
import type { ChromeButtonPress } from "./device-chrome-frame";
import { DuoDeviceButton } from "./duo-device-button";

export interface DuoModelViewProps {
  angle?: number;
  pose?: HingePose | null;
  /** Undefined follows the confirmed pose; null explicitly uses a generic presentation. */
  physicalPose?: HingePose | null;
  streamConfig?: StreamConfig | null;
  hingeCommands?: DuoHingeCommands;
  children: ReactNode;
  onUnavailable?: () => void;
  streamError?: string | null;
  cacheScreenOnFold?: boolean;
  sizeMode?: "physical" | "fill";
  onHingeAngleChange?: (angle: number) => void;
  controlChrome?: DuoControlChrome | null;
  onButton?: (press: ChromeButtonPress) => void;
  onTouch?: (data: { type: "begin" | "move" | "end"; x: number; y: number; edge?: number }) => void;
  onMultiTouch?: (data: { type: "begin" | "move" | "end"; x1: number; y1: number; x2: number; y2: number }) => void;
  onScroll?: (data: { dx: number; dy: number; x: number; y: number }) => void;
}

/** The stream stays mounted while its decoded frames texture the articulated model. */
export function DuoModelView({ children, ...props }: DuoModelViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLDivElement>(null);
  const hingeHandle = useRef<HTMLDivElement>(null);
  const oppositeHingeHandle = useRef<HTMLDivElement>(null);
  const volumeControls = useRef<HTMLDivElement>(null);
  const powerControl = useRef<HTMLDivElement>(null);
  const latest = useRef<DuoSceneState>(props);
  latest.current = props;
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    if (!host.current || !source.current) return;
    let disposed = false;
    const scene = createDuoScene(host.current, source.current, () => latest.current, {
      ready: () => { if (!disposed) setStatus("ready"); },
      error: () => {
        if (!disposed) {
          setStatus("unavailable");
          latest.current.onUnavailable?.();
        }
      },
    }, { left: hingeHandle.current ?? undefined, right: oppositeHingeHandle.current ?? undefined }, {
      volume: volumeControls.current ?? undefined,
      power: powerControl.current ?? undefined,
    });
    return () => { disposed = true; scene.dispose(); };
  }, []);

  const press = (name: string) => {
    const button = props.controlChrome?.buttons.find((button) => button.name === name);
    if (status !== "ready" || !props.onButton || button?.usagePage == null || button.usage == null) return undefined;
    return (phase: "down" | "up") => props.onButton?.({ phase, button });
  };
  const volumeUp = press("volume-up");
  const volumeDown = press("volume-down");
  const power = press("power");
  const controlStyle = { position: "absolute" as const, display: "flex", zIndex: 25 };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }} data-duo-model={status}>
      <div
        ref={source}
        aria-hidden={status !== "unavailable"}
        style={status === "unavailable"
          ? { width: "100%", height: "100%" }
          : { position: "absolute", inset: 0, opacity: 0, pointerEvents: "none", overflow: "hidden" }}
      >
        {children}
      </div>
      <div
        ref={host}
        role="img"
        aria-label={`iPhone Duo 3D preview, ${props.pose ?? "custom"} pose${props.angle === undefined ? "" : `, ${Math.round(props.angle)} degrees`}`}
        style={{ position: "absolute", inset: 0, overflow: "hidden", display: status === "unavailable" ? "none" : undefined, touchAction: "none" }}
      />
      <DuoHingeHandle handleRef={hingeHandle} side="left" angle={props.angle ?? (props.streamConfig?.screenId === 1 ? 0 : 180)} onChange={status === "ready" ? props.onHingeAngleChange : undefined} />
      <DuoHingeHandle handleRef={oppositeHingeHandle} side="right" angle={props.angle ?? (props.streamConfig?.screenId === 1 ? 0 : 180)} onChange={status === "ready" ? props.onHingeAngleChange : undefined} />
      <div ref={volumeControls} data-duo-device-control="volume" style={controlStyle}>
        <DuoDeviceButton label="Volume down" onPress={volumeDown} disabled={!volumeDown}><Volume1 size={20} strokeWidth={2.25} /></DuoDeviceButton>
        <DuoDeviceButton label="Volume up" onPress={volumeUp} disabled={!volumeUp}><Volume2 size={20} strokeWidth={2.25} /></DuoDeviceButton>
      </div>
      <div ref={powerControl} data-duo-device-control="power" style={controlStyle}>
        <DuoDeviceButton label="Power" onPress={power} disabled={!power}><Power size={20} strokeWidth={2.25} /></DuoDeviceButton>
      </div>
      {status === "loading" && <span role="status" className="absolute inset-0 flex items-center justify-center text-xs text-white/60">Loading iPhone Duo…</span>}
      {props.streamError && <span role="alert" className="absolute inset-x-4 bottom-4 rounded-lg bg-black/90 p-3 text-center text-xs text-red-400">{props.streamError}</span>}
      {status === "unavailable" && <span role="status" className="absolute bottom-2 inset-x-0 text-center text-xs text-white/60 pointer-events-none">3D preview unavailable. Showing the live display.</span>}
    </div>
  );
}
