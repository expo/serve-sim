import { HINGE_POSITIONS } from "../../hinge-angle";
import { SimulatorToolbar } from "../simulator";
import closedIcon from "../assets/hinge-closed.svg" with { type: "text" };
import halfOpenIcon from "../assets/hinge-half-open.svg" with { type: "text" };
import openIcon from "../assets/hinge-open.svg" with { type: "text" };

const hingeIcons = new Map(
  ([[0, closedIcon], [90, halfOpenIcon], [180, openIcon]] as const)
    .map(([angle, svg]) => [angle, `url("data:image/svg+xml,${encodeURIComponent(svg)}")`]),
);

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
  onChange: (angle: number) => void;
}) {
  if (!(supported ?? angle !== undefined)) return null;

  return (
    <div
      role="group"
      aria-label="Fold position"
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
            disabled={pending}
            onClick={() => onChange(position.angle)}
            style={{
              background: selected ? "#3b3b3b" : undefined,
              color: selected ? "#fff" : "#c6c6c6",
              cursor: pending ? "progress" : "pointer",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: "block",
                width: 20,
                height: 20,
                backgroundColor: "currentColor",
                maskImage: hingeIcons.get(position.angle),
                maskSize: "contain",
                maskRepeat: "no-repeat",
                maskPosition: "center",
              }}
            />
          </SimulatorToolbar.Button>
        );
      })}
      {error && (
        <span role="alert" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, width: 280, color: "#fca5a5", fontSize: 12 }}>
          {error}
        </span>
      )}
    </div>
  );
}
