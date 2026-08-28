export type DeviceLogFields = {
  process: string;
  subsystem: string;
  category: string;
  message: string;
  level: string;
};

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseDeviceLogEntry(entry: unknown): DeviceLogFields | null {
  if (entry === null || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const message = asString(record.eventMessage);
  if (!message) return null;
  const processPath = asString(record.processImagePath) || asString(record.senderImagePath);
  return {
    process: processPath ? basename(processPath) : "",
    subsystem: asString(record.subsystem),
    category: asString(record.category),
    message,
    level: asString(record.messageType).toLowerCase(),
  };
}

export function parseDeviceLogJson(raw: string): DeviceLogFields | null {
  try {
    return parseDeviceLogEntry(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function isDeviceLogError(level: string): boolean {
  return level === "error" || level === "fault";
}

export function deviceLogMatches(line: DeviceLogFields, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    line.process.toLowerCase().includes(needle) ||
    line.subsystem.toLowerCase().includes(needle) ||
    line.category.toLowerCase().includes(needle) ||
    line.message.toLowerCase().includes(needle)
  );
}
