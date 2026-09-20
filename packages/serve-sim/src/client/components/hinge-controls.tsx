import { useId, useRef, useState, type ReactNode } from "react";
import { HINGE_POSITIONS } from "../../hinge-angle";
import { SimulatorToolbar } from "../simulator";

const HINGE_ICONS: Record<number, ReactNode> = {
  0: (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 4.5h7.5a2.3 2.3 0 0 1 2.3 2.3v10.4a2.3 2.3 0 0 1-2.3 2.3H8z" />
      <circle cx="14.5" cy="8" r=".9" fill="currentColor" stroke="none" />
    </svg>
  ),
  90: (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.6 5.3 11.5 6.4a2.8 2.8 0 0 0 1 0l5.9-1.1c1.6-.3 2.9.7 2.9 2.3v8.8c0 1.6-1.3 2.6-2.9 2.3l-5.9-1.1a2.8 2.8 0 0 0-1 0l-5.9 1.1c-1.6.3-2.9-.7-2.9-2.3V7.6c0-1.6 1.3-2.6 2.9-2.3Z" />
      <path d="m10.6 8 1.4.3 1.4-.3" />
    </svg>
  ),
  180: (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.7" y="4.9" width="18.6" height="14.2" rx="2.5" />
      <path d="M10.6 7.3h2.8" />
    </svg>
  ),
};

export function HingeControls({
  angle,
  supported,
  pending = false,
  error,
  onChange,
}: {
  angle?: number;
  supported?: boolean;
  pending?: boolean;
  error?: string | null;
  onChange: (angle: number, mode?: "animate" | "direct") => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const sliderId = useId();
  const angleButton = useRef<HTMLButtonElement>(null);

  if (!(supported ?? angle !== undefined)) return null;

  return (
    <div
      role="group"
      aria-label="Fold position"
      aria-busy={pending}
      style={{
        position: "relative",
        display: "inline-flex",
        flexShrink: 0,
        gap: 4,
        padding: "6px 8px",
        borderRadius: 18,
        background: "var(--serve-sim-panel-bg, #181818)",
        border: "1px solid rgba(255,255,255,0.1)",
      }}
    >
      {HINGE_POSITIONS.map((position) => {
        const selected = angle !== undefined && Math.abs(angle - position.angle) < 1;
        return (
          <SimulatorToolbar.Button
            key={position.angle}
            aria-label={position.label}
            title={position.label}
            aria-pressed={selected}
            onClick={() => onChange(position.angle)}
            style={{
              background: selected ? "#3b3b3b" : undefined,
              color: selected ? "#fff" : "#c6c6c6",
              cursor: "pointer",
            }}
          >
            {HINGE_ICONS[position.angle]}
          </SimulatorToolbar.Button>
        );
      })}
      <SimulatorToolbar.Button
        ref={angleButton}
        aria-label="Angle"
        title="Adjust hinge angle"
        aria-expanded={expanded}
        aria-controls={sliderId}
        onClick={() => setExpanded((value) => !value)}
      >
        <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="var(--serve-sim-panel-bg, #181818)" /><circle cx="15" cy="17" r="3" fill="var(--serve-sim-panel-bg, #181818)" />
        </svg>
      </SimulatorToolbar.Button>
      {expanded && (
        <div id={sliderId} data-hinge-angle-panel="" style={{ position: "absolute", top: "calc(100% + 8px)", left: "50%", transform: "translateX(-50%)", width: 220, padding: "6px 12px", borderRadius: 12, background: "var(--serve-sim-panel-bg, #181818)", border: "1px solid rgba(255,255,255,0.15)", zIndex: 20 }}
          onKeyDown={(event) => { if (event.key === "Escape") { setExpanded(false); angleButton.current?.focus(); } }}>
          <label style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }} htmlFor={`${sliderId}-range`}>Hinge angle <output>{Math.round(angle ?? 0)}°</output></label>
          <input autoFocus id={`${sliderId}-range`} aria-label="Hinge angle" type="range" min={0} max={180} step={1} value={angle ?? 0}
            onChange={(event) => onChange(Number(event.currentTarget.value), "direct")} style={{ width: "100%", marginTop: 4 }} />
        </div>
      )}
      {error && (
        <span role="alert" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, width: 280, color: "#fca5a5", fontSize: 12 }}>
          {error}
        </span>
      )}
    </div>
  );
}
