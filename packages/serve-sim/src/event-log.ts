export type EventLogSource = "hid" | "exec" | "ui";
export type EventLogStatus = "ok" | "error";

export type EventLogEntry = {
  id: number;
  timestamp: string;
  source: EventLogSource;
  kind: string;
  summary: string;
  device?: string;
  action?: string;
  status?: EventLogStatus;
  details?: Record<string, unknown>;
};

export type EventLogDraft = Omit<EventLogEntry, "id" | "timestamp"> & {
  timestamp?: string;
};

export const EVENT_LOG_MAX_ENTRIES = 500;

let nextEventId = 1;
let entries: EventLogEntry[] = [];
const subscribers = new Set<(entry: EventLogEntry) => void>();

export function recordEventLogEvent(draft: EventLogDraft): EventLogEntry {
  const entry: EventLogEntry = {
    ...draft,
    id: nextEventId++,
    timestamp: draft.timestamp ?? new Date().toISOString(),
  };
  entries.push(entry);
  if (entries.length > EVENT_LOG_MAX_ENTRIES) {
    entries = entries.slice(entries.length - EVENT_LOG_MAX_ENTRIES);
  }
  for (const subscriber of subscribers) {
    try {
      subscriber(entry);
    } catch {
      // Event log observers are diagnostic side-channels. A broken stream must
      // not make the simulator input/command path fail.
    }
  }
  return entry;
}

export function readEventLog(options: {
  device?: string | null;
  sinceId?: number;
  limit?: number;
} = {}): EventLogEntry[] {
  const { device, sinceId } = options;
  const limit = clampLimit(options.limit);
  const filtered = entries.filter((entry) => {
    if (device && entry.device !== device) return false;
    if (sinceId != null && entry.id <= sinceId) return false;
    return true;
  });
  return filtered.slice(Math.max(0, filtered.length - limit));
}

export function subscribeEventLog(
  subscriber: (entry: EventLogEntry) => void,
): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function clearEventLogForTests(): void {
  entries = [];
  nextEventId = 1;
}

export function eventLogEventForHidMessage(
  device: string,
  tag: number,
  payload: unknown,
  screen?: { width: number; height: number },
): EventLogDraft | null {
  const details = recordValue(payload);
  if (!details) return null;

  switch (tag) {
    case 0x03: {
      const type = stringValue(details.type);
      const x = numberValue(details.x);
      const y = numberValue(details.y);
      if (!type || x == null || y == null) return null;
      return {
        device,
        source: "hid",
        kind: "touch",
        action: type,
        summary: `Touch ${type} ${formatPoint(x, y)}`,
        details: withScreen({ ...details, x, y }, screen),
      };
    }
    case 0x04: {
      const button = stringValue(details.button);
      if (!button) return null;
      const phase = stringValue(details.phase) ?? "press";
      return {
        device,
        source: "hid",
        kind: "button",
        action: button,
        summary: phase === "press" ? `Button ${button}` : `Button ${button} ${phase}`,
        details: { ...details, phase },
      };
    }
    case 0x05: {
      const type = stringValue(details.type);
      if (!type) return null;
      return {
        device,
        source: "hid",
        kind: "multi-touch",
        action: type,
        summary: `Multi-touch ${type}`,
        details: withScreen(details, screen),
      };
    }
    case 0x06: {
      const type = stringValue(details.type);
      const usage = numberValue(details.usage);
      if (!type || usage == null) return null;
      return {
        device,
        source: "hid",
        kind: "key",
        action: type,
        summary: `Key ${type} ${usage}`,
        details: { ...details, usage },
      };
    }
    case 0x07: {
      const orientation = stringValue(details.orientation);
      if (!orientation) return null;
      return {
        device,
        source: "hid",
        kind: "rotate",
        action: orientation,
        summary: `Rotate ${orientation}`,
        details,
      };
    }
    case 0x08: {
      const option = stringValue(details.option);
      const enabled = booleanValue(details.enabled);
      if (!option || enabled == null) return null;
      return {
        device,
        source: "hid",
        kind: "ca-debug",
        action: option,
        summary: `CoreAnimation ${option} ${enabled ? "on" : "off"}`,
        details: { ...details, enabled },
      };
    }
    case 0x09:
      return {
        device,
        source: "hid",
        kind: "memory-warning",
        action: "trigger",
        summary: "Memory warning",
      };
    case 0x0a: {
      const delta = numberValue(details.delta);
      if (delta == null) return null;
      return {
        device,
        source: "hid",
        kind: "digital-crown",
        action: "rotate",
        summary: `Digital Crown ${delta > 0 ? "up" : "down"}`,
        details: { ...details, delta },
      };
    }
    case 0x0b: {
      const dx = numberValue(details.dx);
      const dy = numberValue(details.dy);
      if (dx == null || dy == null) return null;
      return {
        device,
        source: "hid",
        kind: "scroll",
        action: "wheel",
        summary: `Scroll ${formatDelta(dx, dy)}`,
        details: withScreen({ ...details, dx, dy }, screen),
      };
    }
    case 0x0c:
      return {
        device,
        source: "hid",
        kind: "software-keyboard",
        action: "toggle",
        summary: "Software keyboard",
      };
    default:
      return null;
  }
}

export function eventLogEventForCommand(
  command: string,
  result?: { exitCode?: number },
): EventLogDraft | null {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) return null;
  if (isUploadPlumbing(tokens)) return null;

  const status = statusFromExitCode(result?.exitCode);
  const commandDetail = { command: compactCommand(command), ...(status ? { exitCode: result?.exitCode } : {}) };
  const simctl = simctlCommand(tokens);
  if (simctl) {
    const { verb, args } = simctl;
    if (verb === "install" && args.length >= 2) {
      const [device, path] = args;
      return {
        device,
        source: "exec",
        kind: "app",
        action: "install",
        status,
        summary: `Install app ${basename(path)}`,
        details: { ...commandDetail, path },
      };
    }
    if (verb === "addmedia" && args.length >= 2) {
      const [device, path] = args;
      return {
        device,
        source: "exec",
        kind: "media",
        action: "addmedia",
        status,
        summary: `Add media ${basename(path)}`,
        details: { ...commandDetail, path },
      };
    }
    if (verb === "launch" && args.length >= 2) {
      const [device, bundleId] = args;
      const isHome = bundleId === "com.apple.springboard";
      return {
        device,
        source: "exec",
        kind: isHome ? "button" : "app",
        action: isHome ? "home" : "launch",
        status,
        summary: isHome ? "Home" : `Launch ${bundleId}`,
        details: { ...commandDetail, bundleId },
      };
    }
    if (verb === "terminate" && args.length >= 2) {
      const [device, bundleId] = args;
      return {
        device,
        source: "exec",
        kind: "app",
        action: "terminate",
        status,
        summary: `Terminate ${bundleId}`,
        details: { ...commandDetail, bundleId },
      };
    }
    if (verb === "io" && args.length >= 2 && args[1] === "screenshot") {
      return {
        device: args[0],
        source: "exec",
        kind: "screenshot",
        action: "capture",
        status,
        summary: "Screenshot",
        details: commandDetail,
      };
    }
  }

  const serveSim = serveSimCommand(tokens);
  if (serveSim) {
    const { verb, args } = serveSim;
    const device = deviceArg(args);
    if (verb === "button") {
      const button = firstPositional(args) ?? "home";
      return {
        device,
        source: "exec",
        kind: "button",
        action: button,
        status,
        summary: `Button ${button}`,
        details: commandDetail,
      };
    }
    if (verb === "tap") {
      const [x, y] = args;
      return {
        device,
        source: "exec",
        kind: "tap",
        action: "tap",
        status,
        summary: `Tap ${formatPoint(Number(x), Number(y))}`,
        details: commandDetail,
      };
    }
    if (verb === "gesture") {
      return {
        device,
        source: "exec",
        kind: "gesture",
        action: "send",
        status,
        summary: "Gesture",
        details: commandDetail,
      };
    }
    if (verb === "rotate") {
      const orientation = firstPositional(args);
      return {
        device,
        source: "exec",
        kind: "rotate",
        action: orientation,
        status,
        summary: orientation ? `Rotate ${orientation}` : "Rotate",
        details: commandDetail,
      };
    }
    if (verb === "memory-warning") {
      return {
        device,
        source: "exec",
        kind: "memory-warning",
        action: "trigger",
        status,
        summary: "Memory warning",
        details: commandDetail,
      };
    }
    if (verb === "ca-debug") {
      const option = firstPositional(args);
      const enabled = args.find((arg) => arg === "on" || arg === "off");
      return {
        device,
        source: "exec",
        kind: "ca-debug",
        action: option,
        status,
        summary: `CoreAnimation ${option ?? "debug"}${enabled ? ` ${enabled}` : ""}`,
        details: commandDetail,
      };
    }
    if (verb === "camera") {
      return {
        device,
        source: "exec",
        kind: "camera",
        action: firstPositional(args) ?? "start",
        status,
        summary: "Camera",
        details: commandDetail,
      };
    }
    if (verb === "ui") {
      const option = firstPositional(args);
      return {
        device,
        source: "exec",
        kind: "ui-setting",
        action: option,
        status,
        summary: option ? `UI ${option}` : "UI setting",
        details: commandDetail,
      };
    }
  }

  if (tokens[0] === "osascript" && command.includes('menu item "Home"')) {
    return {
      source: "exec",
      kind: "button",
      action: "home",
      status,
      summary: "Home",
      details: commandDetail,
    };
  }

  return null;
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? NaN)) return EVENT_LOG_MAX_ENTRIES;
  return Math.min(EVENT_LOG_MAX_ENTRIES, Math.max(1, Math.floor(limit!)));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function withScreen(
  details: Record<string, unknown>,
  screen: { width: number; height: number } | undefined,
): Record<string, unknown> {
  if (!screen || screen.width <= 0 || screen.height <= 0) return details;
  return { ...details, screen };
}

function formatPoint(x: number, y: number): string {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "";
  return `${formatNumber(x)},${formatNumber(y)}`;
}

function formatDelta(dx: number, dy: number): string {
  return `${formatSigned(dx)},${formatSigned(dy)}`;
}

function formatNumber(value: number): string {
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatSigned(value: number): string {
  const formatted = formatNumber(value);
  return value > 0 ? `+${formatted}` : formatted;
}

function statusFromExitCode(exitCode: number | undefined): EventLogStatus | undefined {
  if (exitCode == null) return undefined;
  return exitCode === 0 ? "ok" : "error";
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((ch === "'" || ch === '"') && quote === null) {
      quote = ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(ch) && quote === null) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function isUploadPlumbing(tokens: string[]): boolean {
  if (tokens[0] === "bash" && tokens[1] === "-c" && tokens[2]?.startsWith("echo ")) return true;
  if (tokens[0] === "bash" && tokens[1] === "-c" && tokens[2]?.startsWith("rm -f ")) return true;
  if (tokens[0] === "rm" && tokens[1] === "-f") return true;
  return false;
}

function simctlCommand(tokens: string[]): { verb: string; args: string[] } | null {
  const i = tokens.findIndex((token) => token === "simctl");
  if (i < 0 || tokens[i - 1] !== "xcrun") return null;
  const verb = tokens[i + 1];
  if (!verb) return null;
  return { verb, args: tokens.slice(i + 2) };
}

function serveSimCommand(tokens: string[]): { verb: string; args: string[] } | null {
  const i = tokens.findIndex((token) => token === "serve-sim" || /(?:^|\/)serve-sim(?:\.js)?$/.test(token));
  if (i < 0) return null;
  const verb = tokens[i + 1];
  if (!verb) return null;
  return { verb, args: tokens.slice(i + 2) };
}

function deviceArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-d" || arg === "--device") && args[i + 1]) return args[i + 1];
  }
  return undefined;
}

function firstPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-d" || arg === "--device") {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

function basename(path: string | undefined): string {
  if (!path) return "";
  return path.split("/").filter(Boolean).pop() ?? path;
}

function compactCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}
