import type { CrashFrame, CrashReport } from "./report";

export const MAX_CRASHES = 20;
export const MAX_OCCURRENCES = 5;

export interface CrashOccurrence {
  incidentId: string | null;
  pid: number | null;
  capturedAt: string | null;
  capturedAtMs: number | null;
  rawPath: string;
  frames: CrashFrame[];
  logTail: string[];
  logTailSource: LogTailSource;
  seenAt: number;
}

export interface CrashRecord extends CrashReport {
  id: string;
  rawPath: string;
  logTail: string[];
  logTailSource: LogTailSource;
  occurrences: CrashOccurrence[];
  count: number;
  firstSeen: number;
  lastSeen: number;
}

export type OccurrenceStamp = {
  capturedAtMs: number | null;
  capturedAt: string | null;
  rawPath: string;
};

export type CrashSummary = Omit<CrashRecord, "logTail" | "occurrences"> & {
  logTailLines: number;
  occurrenceCount: number;
  occurrenceTimes: OccurrenceStamp[];
};

export type LogTailSource = "none" | "buffer-rolled-past" | "no-app-lines" | "app-windowed";

export type CrashEvent = { type: "crash" | "recurred"; record: CrashRecord };

type Listener = (event: CrashEvent) => void;

export class CrashStore {
  private readonly bySignature = new Map<string, CrashRecord>();
  private readonly listeners = new Set<Listener>();
  private readonly closeListeners = new Set<() => void>();
  private seq = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  subscribe(listener: Listener, onClosed?: () => void): () => void {
    this.listeners.add(listener);
    if (onClosed) this.closeListeners.add(onClosed);
    return () => {
      this.listeners.delete(listener);
      if (onClosed) this.closeListeners.delete(onClosed);
    };
  }

  close(): void {
    for (const onClosed of [...this.closeListeners]) {
      try {
        onClosed();
      } catch {}
    }
    this.closeListeners.clear();
    this.listeners.clear();
  }

  record(
    report: CrashReport,
    rawPath: string,
    logTail: string[] = [],
    logTailSource: LogTailSource = "none"
  ): CrashRecord {
    const at = this.now();
    const hasNewTail = logTail.length > 0;
    const existing = this.bySignature.get(report.signature);
    const occurrence: CrashOccurrence = {
      incidentId: report.incidentId,
      pid: report.pid,
      capturedAt: report.capturedAt,
      capturedAtMs: report.capturedAtMs,
      rawPath,
      frames: [...report.frames],
      logTail: [...logTail],
      logTailSource,
      seenAt: at,
    };

    if (existing) {
      const updated: CrashRecord = {
        ...report,
        frames: [...report.frames],
        id: existing.id,
        rawPath,
        logTail: hasNewTail ? [...logTail] : existing.logTail,
        logTailSource: hasNewTail ? logTailSource : existing.logTailSource,
        occurrences: [...existing.occurrences, occurrence].slice(-MAX_OCCURRENCES),
        count: existing.count + 1,
        firstSeen: existing.firstSeen,
        lastSeen: at,
      };
      this.bySignature.set(report.signature, updated);
      this.emit({ type: "recurred", record: updated });
      return snapshot(updated);
    }

    const record: CrashRecord = {
      ...report,
      frames: [...report.frames],
      id: report.incidentId ?? `no-incident-${++this.seq}`,
      rawPath,
      logTail: [...logTail],
      logTailSource,
      occurrences: [occurrence],
      count: 1,
      firstSeen: at,
      lastSeen: at,
    };
    this.bySignature.set(report.signature, record);
    this.evictOverflow();
    this.emit({ type: "crash", record });
    return snapshot(record);
  }

  list(): CrashRecord[] {
    return [...this.bySignature.values()].sort((a, b) => b.lastSeen - a.lastSeen).map(snapshot);
  }

  get(id: string): CrashRecord | null {
    for (const record of this.bySignature.values()) {
      if (record.id === id) return snapshot(record);
    }
    return null;
  }

  private evictOverflow(): void {
    if (this.bySignature.size <= MAX_CRASHES) return;
    let oldest = [...this.bySignature][0]!;
    for (const entry of this.bySignature) {
      if (entry[1].lastSeen < oldest[1].lastSeen) oldest = entry;
    }
    this.bySignature.delete(oldest[0]);
  }

  private emit(event: CrashEvent): void {
    const delivered: CrashEvent = { type: event.type, record: snapshot(event.record) };
    for (const listener of this.listeners) {
      try {
        listener(delivered);
      } catch {}
    }
  }
}

function snapshot(record: CrashRecord): CrashRecord {
  return {
    ...record,
    frames: [...record.frames],
    logTail: [...record.logTail],
    occurrences: record.occurrences.map((o) => ({
      ...o,
      frames: [...o.frames],
      logTail: [...o.logTail],
    })),
  };
}
