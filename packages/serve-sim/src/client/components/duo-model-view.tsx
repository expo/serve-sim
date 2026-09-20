import { useEffect, useRef, useState, type ReactNode } from "react";
import type { HingePose } from "../../hinge-control";
import type { StreamConfig } from "../types";
import { createDuoScene, type DuoSceneState } from "../simulator/duo-scene";

export interface DuoModelViewProps {
  angle?: number;
  pose?: HingePose | null;
  /** Undefined follows the confirmed pose; null explicitly uses a generic presentation. */
  physicalPose?: HingePose | null;
  streamConfig?: StreamConfig | null;
  children: ReactNode;
  onTouch?: (data: { type: "begin" | "move" | "end"; x: number; y: number; edge?: number }) => void;
  onMultiTouch?: (data: { type: "begin" | "move" | "end"; x1: number; y1: number; x2: number; y2: number }) => void;
  onScroll?: (data: { dx: number; dy: number; x: number; y: number }) => void;
}

/** The stream stays mounted while its decoded frames texture the articulated model. */
export function DuoModelView({ children, ...props }: DuoModelViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLDivElement>(null);
  const latest = useRef<DuoSceneState>(props);
  latest.current = props;
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    if (!host.current || !source.current) return;
    let disposed = false;
    const scene = createDuoScene(host.current, source.current, () => latest.current, {
      ready: () => { if (!disposed) setStatus("ready"); },
      error: () => { if (!disposed) setStatus("unavailable"); },
    });
    return () => { disposed = true; scene.dispose(); };
  }, []);

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
        style={{ position: "absolute", inset: 0, display: status === "unavailable" ? "none" : undefined, touchAction: "none" }}
      />
      {status === "loading" && <span role="status" className="absolute inset-0 flex items-center justify-center text-xs text-white/60">Loading iPhone Duo…</span>}
      {status === "unavailable" && <span role="status" className="absolute bottom-2 inset-x-0 text-center text-xs text-white/60 pointer-events-none">3D preview unavailable. Showing the live display.</span>}
    </div>
  );
}
