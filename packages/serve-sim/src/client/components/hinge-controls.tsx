import { useEffect, useId, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { SettingSwitch } from "./setting-switch";
import { HINGE_POSES, type HingeControlCommand, type HingePose } from "../../hinge-control";
import { SimulatorToolbar } from "../simulator";
import closedIcon from "../assets/hinge-closed.svg" with { type: "text" };
import laptopIcon from "../assets/hinge-half-open.svg" with { type: "text" };
import bookIcon from "../assets/hinge-half-open-portrait.svg" with { type: "text" };
import openIcon from "../assets/hinge-open.svg" with { type: "text" };
import tentIcon from "../assets/hinge-tent.svg" with { type: "text" };

const hingeIcons = new Map(
  ([
    ["closed", closedIcon], ["open", openIcon], ["laptop", laptopIcon],
    ["book", bookIcon], ["tent", tentIcon],
  ] as const).map(([pose, svg]) => [pose, `url("data:image/svg+xml,${encodeURIComponent(svg)}")`]),
);

export function HingeControls({
  angle, pose, supported, tableMode, tableModeAvailable = false, pending = false, error, onChange,
}: {
  angle?: number;
  pose?: HingePose | null;
  supported?: boolean;
  tableMode?: boolean;
  tableModeAvailable?: boolean;
  pending?: boolean;
  error?: string | null;
  onChange: (command: HingeControlCommand) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [angleDraft, setAngleDraft] = useState<number | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Keep the thumb at the latest requested angle while older requests arrive.
  // Once interaction and the queue finish, use the simulator's confirmed value.
  useEffect(() => {
    if (error || (!pending && !adjusting)) setAngleDraft(null);
  }, [pending, adjusting, error]);

  useEffect(() => {
    if (error) {
      setEditing(false);
      setAdjusting(false);
    }
  }, [error]);

  useEffect(() => {
    if (!expanded) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setExpanded(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [expanded]);

  if (!(supported ?? angle !== undefined)) return null;

  // A partial angle alone cannot distinguish Book from Laptop.
  const displayedAngle = angleDraft ?? angle;
  const selectedPose = angleDraft !== null ? null
    : pose !== undefined ? pose
      : angle === 0 ? "closed" : angle === 180 ? "open" : null;
  const canChangeTableMode = tableModeAvailable || tableMode === true;
  const changeAngle = (value: number) => {
    setAngleDraft(value);
    onChange({ control: "angle", value });
  };

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label="Fold position"
      aria-busy={pending}
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.stopPropagation();
          setExpanded(false);
          toggleRef.current?.focus();
        }
      }}
      style={{
        position: "relative", display: "inline-flex", flexShrink: 0, gap: 4,
        padding: "6px 8px", borderRadius: 18,
        background: "var(--serve-sim-panel-bg, #181818)",
        border: "1px solid rgba(255,255,255,0.1)",
      }}
    >
      {HINGE_POSES.map((position, index) => {
        const selected = selectedPose === position.id;
        return (
          <SimulatorToolbar.Button
            key={position.id}
            aria-label={position.label}
            title={`${position.label} (⌘${index + 1})`}
            aria-pressed={selected}
            onClick={() => {
              setAngleDraft(null);
              setAdjusting(false);
              setEditing(false);
              onChange({ control: "pose", value: position.id });
            }}
            style={{ background: selected ? "#3b3b3b" : undefined, color: selected ? "#fff" : "#c6c6c6", opacity: 1 }}
          >
            <span
              aria-hidden="true"
              style={{
                display: "block", width: 20, height: 20,
                backgroundColor: "currentColor", maskImage: hingeIcons.get(position.id),
                maskSize: "contain", maskRepeat: "no-repeat", maskPosition: "center",
              }}
            />
          </SimulatorToolbar.Button>
        );
      })}
      <SimulatorToolbar.Button
        ref={toggleRef}
        aria-label="Adjust hinge angle"
        title="Adjust hinge angle"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
        style={{ background: expanded ? "#3b3b3b" : undefined, color: "#c6c6c6", opacity: 1 }}
      >
        <SlidersHorizontal aria-hidden="true" size={20} strokeWidth={1.7} />
      </SimulatorToolbar.Button>
      <div
        id={panelId}
        hidden={!expanded}
        role="group"
        aria-label="Fine hinge adjustment"
        style={{
          position: "absolute", zIndex: 30, bottom: "calc(100% + 8px)", left: "50%", transform: "translateX(-50%)",
          width: "min(280px, calc(100vw - 32px))", boxSizing: "border-box",
          padding: 14, borderRadius: 16,
          background: "var(--serve-sim-panel-bg, #181818)",
          border: "1px solid rgba(255,255,255,0.16)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.3)", color: "#eee", fontSize: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <span>Hinge angle</span>
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="number"
              aria-label="Hinge angle in degrees"
              min={0}
              max={180}
              step="any"
              placeholder="—"
              value={editing ? draft : displayedAngle ?? ""}
              onFocus={() => {
                setDraft(displayedAngle === undefined ? "" : String(displayedAngle));
                setEditing(true);
              }}
              onChange={(event) => {
                const { value, valueAsNumber } = event.currentTarget;
                setDraft(value);
                if (Number.isFinite(valueAsNumber) && valueAsNumber >= 0 && valueAsNumber <= 180) {
                  changeAngle(valueAsNumber);
                }
              }}
              onBlur={() => setEditing(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              style={{
                width: 72, minWidth: 0, padding: "5px 6px", borderRadius: 6,
                border: "1px solid #555", background: "#242424", color: "#fff",
                fontSize: 12, textAlign: "right",
              }}
            />
            <span aria-hidden="true">°</span>
          </label>
        </div>
        <input
          type="range"
          aria-label="Hinge angle"
          aria-valuetext={displayedAngle === undefined ? "Unknown" : `${displayedAngle} degrees`}
          min={0}
          max={180}
          step={1}
          value={displayedAngle ?? 90}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setAdjusting(true);
          }}
          onPointerUp={() => setAdjusting(false)}
          onPointerCancel={() => setAdjusting(false)}
          onKeyDown={(event) => {
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
              setAdjusting(true);
            }
          }}
          onKeyUp={() => setAdjusting(false)}
          onBlur={() => setAdjusting(false)}
          onChange={(event) => changeAngle(event.currentTarget.valueAsNumber)}
          style={{ display: "block", width: "100%", margin: 0, accentColor: "#818cf8", cursor: "pointer" }}
        />
        <div aria-hidden="true" style={{ display: "flex", justifyContent: "space-between", marginTop: 6, color: "#bdbdbd", fontSize: 11 }}>
          <span>0°</span>
          <span>180°</span>
        </div>
        <div
          title={canChangeTableMode ? undefined : "Table Mode is not available in the current pose"}
          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 14, paddingTop: 12, borderTop: "1px solid #3b3b3b", color: canChangeTableMode ? "#eee" : "#bdbdbd" }}
        >
          <span>Table Mode</span>
          <SettingSwitch
            label="Table Mode"
            checked={tableMode ?? false}
            disabled={!canChangeTableMode}
            onChange={(value) => onChange({ control: "table", value })}
          />
        </div>
      </div>
      {error && (
        <span role="alert" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, width: "min(280px, calc(100vw - 32px))", color: "#fca5a5", fontSize: 12 }}>
          {error}
        </span>
      )}
    </div>
  );
}
