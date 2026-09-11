import type { DeviceLogLevel } from "../utils/device-log-format";

export function LevelGlyph({
  level,
  className = "size-4",
  active = true,
}: {
  level: DeviceLogLevel;
  className?: string;
  active?: boolean;
}) {
  const svg = `block shrink-0 ${className}`;
  if (level === "fault") {
    return (
      <svg className={svg} viewBox="0 0 16 16" aria-hidden="true">
        {active ? (
          <>
            <polygon points="8,1.6 13.6,4.8 13.6,11.2 8,14.4 2.4,11.2 2.4,4.8" fill="#f87171" />
            <path d="M8 5.4v3.4M8 11h.01" stroke="#1a0000" strokeWidth="1.35" strokeLinecap="round" />
          </>
        ) : (
          <polygon
            points="8,1.6 13.6,4.8 13.6,11.2 8,14.4 2.4,11.2 2.4,4.8"
            fill="none"
            stroke="#52525b"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        )}
      </svg>
    );
  }
  if (level === "error") {
    return (
      <svg className={svg} viewBox="0 0 16 16" aria-hidden="true">
        {active ? (
          <>
            <polygon points="8,1.4 13.2,12.2 2.8,12.2" fill="#fbbf24" />
            <path d="M8 6.1v3M8 10.8h.01" stroke="#1a1200" strokeWidth="1.35" strokeLinecap="round" />
          </>
        ) : (
          <polygon
            points="8,1.8 13.2,12.4 2.8,12.4"
            fill="none"
            stroke="#52525b"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        )}
      </svg>
    );
  }
  if (level === "info") {
    return (
      <svg className={svg} viewBox="0 0 16 16" aria-hidden="true">
        {active ? (
          <>
            <circle cx="8" cy="8" r="6" fill="#60a5fa" />
            <path d="M8 7.2v3.6M8 5.3h.01" stroke="#0b1a33" strokeWidth="1.35" strokeLinecap="round" />
          </>
        ) : (
          <circle cx="8" cy="8" r="5.4" fill="none" stroke="#52525b" strokeWidth="1.5" />
        )}
      </svg>
    );
  }
  if (level === "debug") {
    return (
      <svg className={svg} viewBox="0 0 16 16" aria-hidden="true">
        {active ? (
          <rect x="3" y="3" width="10" height="10" rx="2" fill="#a1a1aa" />
        ) : (
          <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="2" fill="none" stroke="#52525b" strokeWidth="1.5" />
        )}
      </svg>
    );
  }
  return (
    <svg className={svg} viewBox="0 0 16 16" aria-hidden="true">
      {active ? (
        <circle cx="8" cy="8" r="3.1" fill="#a1a1aa" />
      ) : (
        <circle cx="8" cy="8" r="3.1" fill="none" stroke="#52525b" strokeWidth="1.5" />
      )}
    </svg>
  );
}
