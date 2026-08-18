import { SettingSwitch } from "./setting-switch";

export function InteractionSettingsTool({
  interactive,
  onInteractiveChange,
}: {
  interactive: boolean;
  onInteractiveChange: (next: boolean) => void;
}) {
  return (
    <div
      data-interaction-settings=""
      className="bg-panel rounded-[10px] px-3 py-2"
    >
      <div className="flex min-h-9 items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em]">
          Interaction
        </span>
        <SettingSwitch
          label="Interactive"
          checked={interactive}
          onChange={onInteractiveChange}
        />
      </div>
      <p className="m-0 pb-1 text-[11px] leading-snug text-white/55">
        {interactive
          ? "Touch, keyboard, scroll, and device controls are forwarded to the simulator."
          : "View-only: video keeps streaming while simulator input is ignored."}
      </p>
    </div>
  );
}
