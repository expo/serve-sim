// The in-memory record of captured requests. Deliberately platform-neutral: an Android backend
// emitting the same records can reuse the client and UI unchanged, so nothing here mentions the
// proxy, TLS, or simulators. Bodies are held separately and fetched on demand, keeping the live
// stream small and letting the buffer cap total memory rather than tracking payload sizes inline.

export const CAPTURE_SCHEMA_VERSION = 1;

/** How many requests are retained; the oldest are dropped once the window is full. */
const MAX_REQUESTS = 500;
// Throughput is summed over ten 100ms slices, so the total across the window is a per-second rate
// while a single burst can't be double-counted as it ages out.
const TRAFFIC_BUCKET_MS = 100;
const TRAFFIC_WINDOW_BUCKETS = 10;

/** Per-body cap, and the total body budget across the buffer. */
const MAX_BODY_BYTES = 512 * 1024;
const MAX_TOTAL_BODY_BYTES = 16 * 1024 * 1024;

export interface CapturedRequest {
  id: string;
  method: string;
  url: string;
  /** null while the request is still in flight. */
  status: number | null;
  mimeType: string | null;
  requestBytes: number;
  responseBytes: number;
  /** ms since capture started. */
  startedAt: number;
  /** Time to first response byte; null until headers arrive. */
  ttfbMs: number | null;
  durationMs: number | null;
  /**
   * Why the request produced no usable response — a refused connection, an abort, or a client that
   * rejected our leaf (a pinned certificate). Null on success; a pinned app never reports a status,
   * so surfacing the reason is the only way the UI can explain an empty row.
   */
  failure: string | null;
}

/** Everything a body viewer needs; kept out of CapturedRequest so the stream stays light. */
export interface CapturedBody {
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody: string | null;
  responseBody: string | null;
  /** True when a body was dropped for exceeding the size cap rather than being absent. */
  requestTruncated: boolean;
  responseTruncated: boolean;
  /**
   * Set when a body is not text.
   *
   * The proxy reports binary and still-compressed bodies separately from text ones, and decoding those
   * as UTF-8 turns an image into a screen of replacement characters. Recording which is which lets the
   * viewer say "binary body" instead of rendering mojibake, and keeps the byte count meaningful.
   */
  requestBinary: boolean;
  responseBinary: boolean;
}

/**
 * Whether the app's traffic is reaching the proxy:
 *   pending   — the proxy is starting and the app has not been relaunched yet
 *   attached  — the app was relaunched with the proxy applied to its own process
 *   no-target — the proxy is up but no app was relaunched, so nothing will arrive
 *   failed    — capture could not start; `captureError` says why
 *
 * Nothing here touches the host. The proxy is applied inside the app by an injected library, so there is
 * no machine-wide setting to set or restore.
 */
export type CaptureAttachment = "no-target" | "pending" | "attached" | "failed";

export interface CaptureMeta {
  schemaVersion: number;
  udid: string;
  /** Proxy address apps should be pointed at, e.g. "127.0.0.1:9123". */
  proxyAddress: string | null;
  attachment: CaptureAttachment;
  /** Why routing failed, for a UI that must explain an empty capture. */
  attachError: string | null;
}

type Listener = (event: CaptureEvent) => void;

/** Live stream frames. `started` then `finished` per request; the client keys on id. */
export type CaptureEvent =
  | { type: "started"; request: CapturedRequest }
  | { type: "finished"; request: CapturedRequest }
  | { type: "cleared" }
  /**
   * A revised session state, pushed after the one sent at subscribe time.
   *
   * Capture can stop being true after it started — the proxy can die mid-session — and without this the
   * panel would keep showing the state it was told once and simply stop receiving rows.
   */
  | { type: "meta"; meta: CaptureMeta };

/**
 * A bounded log of captured requests with a live subscription. One store per device, owned by the
 * capture session; the SSE route replays `list()` to a new subscriber before attaching it, so a
 * viewer that connects mid-session still sees the requests already made.
 */
export class CaptureStore {
  private readonly requests = new Map<string, CapturedRequest>();
  private readonly bodies = new Map<string, CapturedBody>();
  private readonly listeners = new Set<Listener>();
  private totalBodyBytes = 0;
  private seq = 0;
  /** Byte counts bucketed by time slice, kept only for the trailing throughput window. */
  private readonly traffic = new Map<number, { in: number; out: number }>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  get listenerCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Requests oldest-first, for replaying to a fresh subscriber. */
  list(): CapturedRequest[] {
    return [...this.requests.values()];
  }

  body(id: string): CapturedBody | null {
    return this.bodies.get(id) ?? null;
  }

  /** Register a request as it begins; returns the id later passed to finish/fail. */
  start(method: string, url: string): string {
    const id = `r${++this.seq}`;
    const request: CapturedRequest = {
      id,
      method,
      url,
      status: null,
      mimeType: null,
      requestBytes: 0,
      responseBytes: 0,
      startedAt: this.now(),
      ttfbMs: null,
      durationMs: null,
      failure: null,
    };
    this.requests.set(id, request);
    this.evictOverflow();
    this.emit({ type: "started", request });
    return id;
  }

  /** Patch a request in place and, once it has settled, publish it. */
  update(id: string, patch: Partial<Omit<CapturedRequest, "id">>, settled = false): void {
    const request = this.requests.get(id);
    if (!request) return; // evicted from the window while in flight
    Object.assign(request, patch);
    if (settled) this.emit({ type: "finished", request });
  }

  /** Attach headers/bodies for a request, honoring the per-body and total budgets. */
  setBody(id: string, body: CapturedBody): void {
    if (!this.requests.has(id)) return;
    const size = (body.requestBody?.length ?? 0) + (body.responseBody?.length ?? 0);
    if (this.totalBodyBytes + size > MAX_TOTAL_BODY_BYTES) return; // budget spent; keep metadata only
    this.bodies.set(id, body);
    this.totalBodyBytes += size;
  }

  /** Publish a revised session state to every viewer. */
  publishMeta(meta: CaptureMeta): void {
    this.emit({ type: "meta", meta });
  }

  clear(): void {
    this.requests.clear();
    this.bodies.clear();
    this.totalBodyBytes = 0;
    this.emit({ type: "cleared" });
  }

  /**
   * Record a transfer at the rate it flowed, spread over the time it took.
   *
   * A request is only reported once it finishes, so adding its whole size at that instant would put a
   * 30-second download in one 100ms slice: the graph reads zero throughout, then spikes. Dividing the
   * bytes across the slices the transfer spanned makes the reading a rate.
   */
  noteTraffic(inBytes: number, outBytes: number, durationMs = 0): void {
    const current = Math.floor(this.now() / TRAFFIC_BUCKET_MS);
    const slices = Math.ceil(Math.max(TRAFFIC_BUCKET_MS, durationMs) / TRAFFIC_BUCKET_MS);
    const share = { in: inBytes / slices, out: outBytes / slices };

    // Slices outside the window can't affect a reading, so a long transfer costs no more than a short one.
    const earliest = Math.max(current - slices + 1, current - TRAFFIC_WINDOW_BUCKETS);
    for (let bucket = earliest; bucket <= current; bucket++) {
      const entry = this.traffic.get(bucket) ?? { in: 0, out: 0 };
      entry.in += share.in;
      entry.out += share.out;
      this.traffic.set(bucket, entry);
    }
    this.pruneTraffic(current);
  }

  /** Bytes per second over the trailing second, from the proxy's own accounting. */
  throughput(): { in: number; out: number } {
    const bucket = Math.floor(this.now() / TRAFFIC_BUCKET_MS);
    this.pruneTraffic(bucket);
    let inTotal = 0;
    let outTotal = 0;
    for (const { in: i, out: o } of this.traffic.values()) {
      inTotal += i;
      outTotal += o;
    }
    // The window is a whole second, so the sum across it is already a per-second rate.
    return { in: Math.round(inTotal), out: Math.round(outTotal) };
  }

  private pruneTraffic(currentBucket: number): void {
    const oldest = currentBucket - TRAFFIC_WINDOW_BUCKETS;
    for (const bucket of this.traffic.keys()) {
      if (bucket <= oldest) this.traffic.delete(bucket);
    }
  }

  private evictOverflow(): void {
    while (this.requests.size > MAX_REQUESTS) {
      const oldest = this.requests.keys().next();
      if (oldest.done) return;
      const body = this.bodies.get(oldest.value);
      if (body) {
        this.totalBodyBytes -= (body.requestBody?.length ?? 0) + (body.responseBody?.length ?? 0);
        this.bodies.delete(oldest.value);
      }
      this.requests.delete(oldest.value);
    }
  }

  private emit(event: CaptureEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A failing subscriber (e.g. a write to an already-closed SSE response) must not
        // starve the other viewers of this event.
      }
    }
  }
}

/** Cap a body for storage, reporting whether it was cut. */
export function clampBody(buffers: Buffer[]): { text: string | null; truncated: boolean } {
  if (buffers.length === 0) return { text: null, truncated: false };
  const joined = Buffer.concat(buffers);
  if (joined.length <= MAX_BODY_BYTES) return { text: joined.toString("utf8"), truncated: false };
  return { text: joined.subarray(0, MAX_BODY_BYTES).toString("utf8"), truncated: true };
}
