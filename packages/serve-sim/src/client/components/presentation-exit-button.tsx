import { Minimize2 } from "lucide-react";

export function PresentationExitButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="fixed top-3 right-3 z-50 flex items-center gap-1 p-1">
      <button
        type="button"
        onClick={onClick}
        className="w-[30px] h-[30px] flex items-center justify-center bg-transparent border-none rounded-md text-[#8e8e93] cursor-pointer [transition:background_0.15s_ease,color_0.15s_ease] hover:bg-white/8 hover:text-white"
        aria-label="Exit full screen"
        title="Exit full screen (Esc)"
      >
        <Minimize2 size={18} strokeWidth={1.75} />
      </button>
    </div>
  );
}
