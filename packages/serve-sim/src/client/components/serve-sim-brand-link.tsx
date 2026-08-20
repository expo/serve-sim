import { ArrowLeft } from "lucide-react";

export const EAS_SIMULATOR_URL = "https://expo.dev/services/simulators";

export function ServeSimBrandLink({
  className = "",
  sessionDetailsUrl,
}: {
  className?: string;
  sessionDetailsUrl?: string;
}) {
  const isSessionLink = !!sessionDetailsUrl;
  return (
    <a
      href={sessionDetailsUrl ?? EAS_SIMULATOR_URL}
      target={isSessionLink ? undefined : "_blank"}
      rel={isSessionLink ? undefined : "noreferrer"}
      className={`inline-flex h-[30px] min-w-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 font-mono text-[12px] font-semibold text-white/65 no-underline [transition:background_0.15s_ease,color_0.15s_ease] hover:bg-white/8 hover:text-white/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60 ${className}`.trim()}
      aria-label={isSessionLink ? "Back to simulator session details" : "Open EAS Simulator"}
      title={isSessionLink ? "Back to session details" : "Open EAS Simulator"}
    >
      {isSessionLink ? (
        <>
          <ArrowLeft size={14} strokeWidth={2} className="shrink-0 text-white/85" />
          Session details
        </>
      ) : (
        "EAS Simulator"
      )}
    </a>
  );
}
