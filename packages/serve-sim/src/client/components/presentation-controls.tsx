import { GripVertical, Minimize2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  nearestCorner,
  presentationCornerStyle,
  isPresentationCorner,
  PRESENTATION_CORNER_STORAGE_KEY,
  PRESENTATION_EXIT_BUTTON_SIZE,
  PRESENTATION_EXIT_MARGIN,
  PRESENTATION_EXIT_WRAPPER_PADDING,
  type PresentationCorner,
} from "../utils/presentation";

const SNAP_TRANSITION = "top 0.22s cubic-bezier(0.4,0,0.2,1), bottom 0.22s cubic-bezier(0.4,0,0.2,1), left 0.22s cubic-bezier(0.4,0,0.2,1), right 0.22s cubic-bezier(0.4,0,0.2,1)";

function storedCorner(): PresentationCorner {
  try {
    const raw = localStorage.getItem(PRESENTATION_CORNER_STORAGE_KEY);
    if (isPresentationCorner(raw)) return raw;
  } catch {}
  return "top-right";
}

function storeCorner(c: PresentationCorner) {
  try {
    localStorage.setItem(PRESENTATION_CORNER_STORAGE_KEY, c);
  } catch {}
}

export function PresentationControls({
  onExit,
  gutters,
  children,
}: {
  onExit: () => void;
  gutters: { side: number; top: number };
  children?: ReactNode;
}) {
  const [corner, setCorner] = useState<PresentationCorner>(storedCorner);
  const [dragging, setDragging] = useState(false);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const snapTo = useCallback(
    (c: PresentationCorner) => {
      setCorner(c);
      storeCorner(c);
    },
    [],
  );

  useEffect(() => {
    setCorner(storedCorner());
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setDragging(true);
      const el = containerRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        setDragPos({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      e.stopPropagation();
      setDragPos({ x: e.clientX, y: e.clientY });
    },
    [dragging],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      e.stopPropagation();
      const target = nearestCorner(e.clientX, e.clientY, {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      snapTo(target);
      setDragging(false);
      setDragPos(null);
    },
    [dragging, snapTo],
  );

  const positionStyle = dragging && dragPos
    ? {
        position: "fixed" as const,
        left: dragPos.x,
        top: dragPos.y,
        right: undefined as undefined,
        bottom: undefined as undefined,
        transform: "translate(-50%, -50%)",
        transition: undefined as undefined,
      }
    : {
        position: "fixed" as const,
        ...presentationCornerStyle(corner, gutters),
        transform: undefined as undefined,
        transition: SNAP_TRANSITION,
      };

  return (
    <div
      ref={containerRef}
      className="z-50 flex items-center gap-0.5 rounded-[10px] bg-black/40 backdrop-blur-[12px] [-webkit-backdrop-filter:blur(12px)] border border-white/10"
      style={{
        ...positionStyle,
        padding: PRESENTATION_EXIT_WRAPPER_PADDING,
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div
        className="flex items-center justify-center cursor-grab active:cursor-grabbing text-[#8e8e93] hover:text-white/70 select-none touch-none"
        style={{ width: 20, height: PRESENTATION_EXIT_BUTTON_SIZE }}
        onPointerDown={onPointerDown}
        aria-label="Drag to reposition"
        title="Drag to reposition"
      >
        <GripVertical size={14} strokeWidth={1.5} />
      </div>
      {children}
      <button
        type="button"
        onClick={onExit}
        className="flex items-center justify-center bg-transparent border-none rounded-md text-[#8e8e93] cursor-pointer [transition:background_0.15s_ease,color_0.15s_ease] hover:bg-white/8 hover:text-white"
        style={{ width: PRESENTATION_EXIT_BUTTON_SIZE, height: PRESENTATION_EXIT_BUTTON_SIZE }}
        aria-label="Exit full screen"
        title="Exit full screen (Esc)"
      >
        <Minimize2 size={18} strokeWidth={1.75} />
      </button>
    </div>
  );
}
