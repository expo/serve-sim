import { Ban, ChevronDown, ChevronRight, Folder, Radio, TriangleAlert } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import {
  fetchCapturedBody,
  useCaptureStream,
  type CaptureAttachment,
  type CapturedBody,
  type CapturedRequest,
} from "../hooks/use-capture-stream";
import { formatRate } from "../utils/format-metrics";
import { simEndpoint } from "../utils/sim-endpoint";
import { CollapsibleSection } from "./collapsible-section";

/** Bytes as a compact size (the rate formatter's units without the per-second suffix). */
function formatBytes(bytes: number): string {
  return formatRate(bytes).replace("/s", "");
}

/** Milliseconds, switching to seconds once "1400ms" is harder to read than "1.4s". */
export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** The pale tint for a status pill: 2xx quiet, 3xx informational, 4xx/5xx and failures loud. */
function statusTint(request: CapturedRequest): string {
  if (request.failure) return "bg-red-500/15 text-red-300";
  if (request.status === null) return "bg-white/10 text-white/50";
  if (request.status >= 500) return "bg-red-500/15 text-red-300";
  if (request.status >= 400) return "bg-amber-500/15 text-amber-300";
  if (request.status >= 300) return "bg-sky-500/15 text-sky-300";
  return "bg-emerald-500/15 text-emerald-300";
}

/** The path (plus query) of a URL, which is what identifies a row; the host is shown separately. */
function splitUrl(raw: string): { host: string; path: string } {
  try {
    const url = new URL(raw);
    return { host: url.host, path: `${url.pathname}${url.search}` || "/" };
  } catch {
    return { host: "", path: raw };
  }
}

export interface DomainGroup {
  host: string;
  requests: CapturedRequest[];
  bytes: number;
  failed: number;
}

/** Rows by host, in the order the hosts were last seen, so the newest traffic stays at the top. */
export function groupByDomain(requests: CapturedRequest[]): DomainGroup[] {
  const groups = new Map<string, DomainGroup>();
  for (const request of requests) {
    const { host } = splitUrl(request.url);
    const key = host || "unknown";
    const group = groups.get(key) ?? { host: key, requests: [], bytes: 0, failed: 0 };
    group.requests.push(request);
    group.bytes += request.requestBytes + request.responseBytes;
    if (request.failure || (request.status ?? 0) >= 400) group.failed++;
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Live table of the device's HTTPS requests, captured through serve-sim's proxy. */
export function NetworkCaptureTool({ udid, captureEndpoint }: { udid: string; captureEndpoint?: string }) {
  const path = useMemo(
    () => captureEndpoint ?? `${simEndpoint("network-capture")}?device=${encodeURIComponent(udid)}`,
    [captureEndpoint, udid],
  );
  const bodyBase = useMemo(() => path.split("?")[0]!, [path]);
  const [open, setOpen] = useState(true);
  const [grouped, setGrouped] = useState(false);
  const [filter, setFilter] = useState("");
  const [rebooting, setRebooting] = useState(false);
  // Read-only: capture belongs to the booted device, so watching it cannot turn it on or off.
  const { meta, requests, errored, clear } = useCaptureStream(path, open);
  const capturing = meta?.attachment === "capturing";
  const starting = meta?.attachment === "starting";

  // Newest first, so the request just made is where the eye already is.
  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched = needle
      ? requests.filter((request) => request.url.toLowerCase().includes(needle))
      : requests;
    return [...matched].reverse();
  }, [requests, filter]);

  const totals = useMemo(
    () => ({
      bytes: rows.reduce((sum, r) => sum + r.requestBytes + r.responseBytes, 0),
      failed: rows.filter((r) => r.failure || (r.status ?? 0) >= 400).length,
    }),
    [rows],
  );

  // Every bar is drawn against the slowest request on screen, so their widths are comparable.
  const slowestMs = useMemo(
    () => Math.max(1, ...rows.map((r) => r.durationMs ?? 0)),
    [rows],
  );

  const groups = useMemo(() => (grouped ? groupByDomain(rows) : []), [grouped, rows]);

  async function reboot(enable: boolean) {
    setRebooting(true);
    try {
      await fetch(`${bodyBase}/reboot?device=${encodeURIComponent(udid)}&enabled=${enable ? "1" : "0"}`, {
        method: "POST",
      });
    } finally {
      setRebooting(false);
    }
  }

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">
            Network requests
          </span>
          {capturing && !errored ? (
            <span className="text-[11px] text-white/40 tabular-nums text-right">{rows.length}</span>
          ) : errored ? (
            <span className="group relative justify-self-end inline-flex items-center" role="status">
              <TriangleAlert aria-hidden="true" className="w-3.5 h-3.5 text-amber-400" />
              <span className="sr-only">The capture stream disconnected</span>
              <span className="pointer-events-none absolute right-0 top-full z-10 mt-1 hidden w-max max-w-[220px] rounded-md bg-black/90 px-2 py-1 text-[11px] leading-snug text-white/90 shadow-lg group-hover:block">
                The capture stream disconnected
              </span>
            </span>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] ${
              capturing ? "bg-amber-500/15 text-amber-300" : "bg-white/5 text-white/50"
            }`}
          >
            <Radio aria-hidden="true" className="w-3 h-3" />
            {capturing ? "Capturing" : "Not capturing"}
          </span>
          <button
            type="button"
            disabled={rebooting || starting}
            onClick={() => void reboot(!capturing)}
            className="rounded px-2 py-1 text-[11px] text-white/60 hover:bg-white/10 disabled:opacity-50"
          >
            {rebooting ? "Rebooting…" : capturing ? "Reboot without capture" : "Reboot with capture"}
          </button>
        </div>

        <CaptureState
          attachment={meta?.attachment ?? "not-enabled"}
          attachError={meta?.attachError ?? null}
        />

        {/* Shown whenever there is history: a device that stopped capturing keeps what it already recorded,
            and hiding it would take the developer's evidence away at the moment they need it. */}
        {(capturing || rows.length > 0) && (
          <>
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter"
                aria-label="Filter requests by URL"
                className="flex-1 min-w-0 rounded bg-white/5 px-2 py-1 text-[11px] text-white/80 placeholder:text-white/30 focus:outline-none focus:bg-white/10"
              />
              <button
                type="button"
                aria-label="Group by domain"
                aria-pressed={grouped}
                onClick={() => setGrouped((on) => !on)}
                className={`rounded p-1 ${grouped ? "bg-sky-500/15 text-sky-300" : "text-white/40 hover:bg-white/10"}`}
              >
                <Folder aria-hidden="true" className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                aria-label="Clear captured requests"
                onClick={clear}
                className="rounded p-1 text-white/40 hover:bg-white/10"
              >
                <Ban aria-hidden="true" className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Bounded so the panel keeps its height however much traffic arrives. */}
            <div className="thin-scroll max-h-64 overflow-y-auto pr-1.5 border-t border-white/5">
              {rows.length === 0 ? (
                <span className="block py-2 text-[11px] text-white/40">
                  {filter ? "No requests match that filter." : "No requests captured yet."}
                </span>
              ) : grouped ? (
                groups.map((group) => (
                  <DomainSection key={group.host} group={group} bodyBase={bodyBase} slowestMs={slowestMs} />
                ))
              ) : (
                rows.map((request) => (
                  <RequestRow
                    key={request.id}
                    request={request}
                    bodyBase={bodyBase}
                    slowestMs={slowestMs}
                  />
                ))
              )}
            </div>

            <div className="border-t border-white/5 pt-1.5 text-[11px] text-white/40 tabular-nums">
              {grouped && `${groups.length} domain${groups.length === 1 ? "" : "s"} · `}
              {rows.length} request{rows.length === 1 ? "" : "s"} · {formatBytes(totals.bytes)}
              {totals.failed > 0 && <span className="text-red-400/80"> · {totals.failed} failed</span>}
            </div>
          </>
        )}
      </div>
    </CollapsibleSection>
  );
}

/**
 * Why this device is not giving you rows. Nothing at all when it is.
 *
 * Reporting the reason is the whole point: an empty list otherwise looks the same whether capture never
 * started or the app simply made no requests. A healthy session says nothing, because the badge already has.
 */
export function CaptureState({
  attachment,
  attachError,
}: {
  attachment: CaptureAttachment;
  attachError: string | null;
}) {
  if (attachment === "capturing") return null;
  if (attachment === "failed") {
    return (
      <span className="whitespace-pre-line text-[11px] leading-snug text-amber-400/80">
        {attachError ?? "Capture could not start."}
      </span>
    );
  }
  if (attachment === "starting") {
    return <span className="text-[11px] text-white/40">Starting capture on this device…</span>;
  }
  return (
    <span className="whitespace-pre-line text-[11px] leading-snug text-white/40">
      {attachError ?? "This device is not capturing."}
    </span>
  );
}

/** One host's requests, collapsed by default so a busy domain does not bury the rest. */
export function DomainSection({
  group,
  bodyBase,
  slowestMs,
}: {
  group: DomainGroup;
  bodyBase: string;
  slowestMs: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-white/5 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((on) => !on)}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 py-1.5 text-left"
      >
        {open ? (
          <ChevronDown aria-hidden="true" className="w-3 h-3 shrink-0 text-white/30" />
        ) : (
          <ChevronRight aria-hidden="true" className="w-3 h-3 shrink-0 text-white/30" />
        )}
        <span className="flex-1 truncate text-[11px] text-white/80" title={group.host}>
          {group.host}
        </span>
        {/* A roll-up, so a collapsed domain still shows that something in it failed. */}
        {group.failed > 0 ? (
          <span className="shrink-0 rounded bg-red-500/15 px-1.5 text-[10px] tabular-nums text-red-300">
            {group.failed} failed
          </span>
        ) : (
          <span className="shrink-0 text-[10px] tabular-nums text-white/30">
            {group.requests.length} req · {formatBytes(group.bytes)}
          </span>
        )}
      </button>
      {open && (
        <div className="pl-3">
          {group.requests.map((request) => (
            <RequestRow key={request.id} request={request} bodyBase={bodyBase} slowestMs={slowestMs} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The wait-then-transfer split of one request, as a share of the slowest request on screen. */
export function TimingBar({ request, slowestMs }: { request: CapturedRequest; slowestMs: number }) {
  const total = request.durationMs ?? 0;
  const wait = Math.min(request.ttfbMs ?? 0, total);
  const scale = (ms: number) => `${Math.max(0, Math.min(100, (ms / slowestMs) * 100))}%`;

  if (request.failure) {
    return (
      <div className="mt-1.5 h-1 rounded-sm bg-white/5">
        <div className="h-full rounded-sm bg-red-400/50" style={{ width: scale(total) }} />
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex h-1 rounded-sm bg-white/5 overflow-hidden">
      <div className="h-full bg-white/25" style={{ width: scale(wait) }} />
      <div className="h-full bg-sky-400/60" style={{ width: scale(total - wait) }} />
    </div>
  );
}

/** One fact about a request. Omitted entirely when there is nothing to say. */
function Fact({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <>
      <span className="text-white/30">{label}</span>
      <span className="text-white/70 tabular-nums">{value}</span>
    </>
  );
}

/** The facts a developer asks for first, before reaching for headers or a body. */
export function RequestFacts({ request }: { request: CapturedRequest }) {
  const wait = request.ttfbMs;
  const total = request.durationMs;
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 text-[10px]">
      <Fact label="Method" value={request.method} />
      <Fact label="Type" value={request.mimeType} />
      <Fact label="Sent" value={request.requestBytes > 0 ? formatBytes(request.requestBytes) : null} />
      <Fact label="Received" value={formatBytes(request.responseBytes)} />
      <Fact label="Waiting" value={wait !== null ? formatMs(wait) : null} />
      <Fact label="Total" value={total !== null ? formatMs(total) : null} />
    </div>
  );
}

/** A part of the detail that is worth a click rather than always-on screen space. */
function DetailSection({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-white/5">
      <button
        type="button"
        onClick={() => setOpen((on) => !on)}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 py-1 text-left"
      >
        {open ? (
          <ChevronDown aria-hidden="true" className="w-2.5 h-2.5 shrink-0 text-white/30" />
        ) : (
          <ChevronRight aria-hidden="true" className="w-2.5 h-2.5 shrink-0 text-white/30" />
        )}
        <span className="flex-1 text-[10px] text-white/50">{label}</span>
        <span className="text-[10px] tabular-nums text-white/30">{hint}</span>
      </button>
      {open && <div className="pb-1">{children}</div>}
    </div>
  );
}

/** One request; expanding it fetches the headers and bodies the stream leaves out. */
export function RequestRow({
  request,
  bodyBase,
  slowestMs,
}: {
  request: CapturedRequest;
  bodyBase: string;
  slowestMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [body, setBody] = useState<CapturedBody | null>(null);
  const [loading, setLoading] = useState(false);
  const { host, path } = splitUrl(request.url);
  // Whichever direction carried the payload; the method already says which one that was.
  const payload = Math.max(request.requestBytes, request.responseBytes);

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (!next || body || loading) return;
    setLoading(true);
    setBody(await fetchCapturedBody(bodyBase, request.id));
    setLoading(false);
  }

  return (
    <div className="py-1.5 border-b border-white/5 last:border-b-0">
      <button type="button" onClick={toggle} className="w-full text-left">
        <div className="flex items-center gap-1.5">
          <span className={`shrink-0 rounded px-1 text-[10px] tabular-nums ${statusTint(request)}`}>
            {request.failure ? "err" : (request.status ?? "···")}
          </span>
          <span className="flex-1 truncate text-[11px] text-white/80" title={request.url}>
            {path}
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-white/40">{formatBytes(payload)}</span>
        </div>
        <TimingBar request={request} slowestMs={slowestMs} />
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-white/30">
          <span className="shrink-0">{request.method}</span>
          <span className="flex-1 truncate">{host}</span>
          <span className="shrink-0 tabular-nums">
            {request.durationMs !== null ? formatMs(request.durationMs) : ""}
          </span>
        </div>
      </button>
      {expanded && (
        <div className="mt-1.5 pl-2 flex flex-col gap-1.5">
          <span className="break-all text-[10px] leading-snug text-white/40">{request.url}</span>
          {request.failure && (
            <span className="rounded bg-red-500/10 px-1.5 py-1 text-[10px] leading-snug text-red-300">
              {request.failure}
            </span>
          )}
          <RequestFacts request={request} />
          {loading && <span className="text-[10px] text-white/30">Loading…</span>}
          {body && <BodyDetail body={body} />}
        </div>
      )}
    </div>
  );
}


/** Headers and bodies for an expanded row, each behind a toggle so the panel keeps its height. */
function BodyDetail({ body }: { body: CapturedBody }) {
  const requestCount = Object.keys(body.requestHeaders).length;
  const responseCount = Object.keys(body.responseHeaders).length;
  return (
    <div className="flex flex-col">
      {requestCount > 0 && (
        <DetailSection label="Request headers" hint={String(requestCount)}>
          <HeaderList headers={body.requestHeaders} />
        </DetailSection>
      )}
      {responseCount > 0 && (
        <DetailSection label="Response headers" hint={String(responseCount)}>
          <HeaderList headers={body.responseHeaders} />
        </DetailSection>
      )}
      <BodySection
        label="Request body"
        text={body.requestBody}
        binary={body.requestBinary}
        truncated={body.requestTruncated}
      />
      <BodySection
        label="Response body"
        text={body.responseBody}
        binary={body.responseBinary}
        truncated={body.responseTruncated}
      />
    </div>
  );
}

/** A body, if there is one. Binary is named rather than rendered as replacement characters. */
function BodySection({
  label,
  text,
  binary,
  truncated,
}: {
  label: string;
  text: string | null;
  binary: boolean;
  truncated: boolean;
}) {
  if (binary) {
    return (
      <DetailSection label={label} hint="binary">
        <span className="text-[10px] text-white/40">Binary body — not shown.</span>
      </DetailSection>
    );
  }
  if (!text) return null;
  return (
    <DetailSection label={label} hint={truncated ? "truncated" : formatBytes(text.length)}>
      <pre className="thin-scroll max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 px-1.5 py-1 text-[10px] text-white/60">
        {text}
      </pre>
    </DetailSection>
  );
}

function HeaderList({ headers }: { headers: Record<string, string> }) {
  return (
    <div className="flex flex-col gap-0.5 text-[10px] leading-snug">
      {Object.entries(headers).map(([name, value]) => (
        <span key={name} className="break-all">
          <span className="text-white/30">{name}</span> <span className="text-white/60">{value}</span>
        </span>
      ))}
    </div>
  );
}

