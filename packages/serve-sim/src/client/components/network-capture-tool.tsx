import { Ban, ChevronDown, ChevronRight, Download, Folder, Radio, TriangleAlert } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import {
  captureAuthHeaders,
  fetchCapturedBody,
  useCaptureStream,
  type CaptureAttachment,
  type CaptureMeta,
  type CapturedBody,
  type CapturedRequest,
} from "../hooks/use-capture-stream";
import { formatRate } from "../utils/format-metrics";
import { simEndpoint } from "../utils/sim-endpoint";
import { CollapsibleSection } from "./collapsible-section";

function formatBytes(bytes: number): string {
  return formatRate(bytes).replace("/s", "");
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function statusTint(request: CapturedRequest): string {
  if (request.failure) return "bg-red-500/15 text-red-300";
  if (request.status === null) return "bg-white/10 text-white/50";
  if (request.status >= 500) return "bg-red-500/15 text-red-300";
  if (request.status >= 400) return "bg-amber-500/15 text-amber-300";
  if (request.status >= 300) return "bg-sky-500/15 text-sky-300";
  return "bg-emerald-500/15 text-emerald-300";
}

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

function isFailedRequest(request: CapturedRequest): boolean {
  return !!request.failure || (request.status ?? 0) >= 400;
}

export function groupByDomain(requests: CapturedRequest[]): DomainGroup[] {
  const groups = new Map<string, DomainGroup>();
  for (const request of requests) {
    const { host } = splitUrl(request.url);
    const key = host || "unknown";
    const group = groups.get(key) ?? { host: key, requests: [], bytes: 0, failed: 0 };
    group.requests.push(request);
    group.bytes += request.requestBytes + request.responseBytes;
    if (isFailedRequest(request)) group.failed++;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function NetworkCaptureTool({ udid, captureEndpoint }: { udid: string; captureEndpoint?: string }) {
  const path = useMemo(
    () => captureEndpoint ?? `${simEndpoint("network-capture")}?device=${encodeURIComponent(udid)}`,
    [captureEndpoint, udid],
  );
  const bodyBase = useMemo(() => path.split("?")[0] ?? path, [path]);
  const harUrl = useMemo(
    () => `${bodyBase}.har?device=${encodeURIComponent(udid)}`,
    [bodyBase, udid],
  );
  const [open, setOpen] = useState(true);
  const [grouped, setGrouped] = useState(false);
  const [filter, setFilter] = useState("");
  const [rebooting, setRebooting] = useState(false);
  const [rebootError, setRebootError] = useState<string | null>(null);
  // Bump after reboot so SSE resubscribes.
  const [streamKey, setStreamKey] = useState(0);
  const { meta, requests, errored, clear, setMeta } = useCaptureStream(path, streamKey);
  const capturing = meta?.attachment === "capturing";
  const starting = meta?.attachment === "starting";
  const captureOn = capturing || starting;
  const rebootButton = rebootControl({ meta, errored, rebooting });

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
      failed: rows.filter(isFailedRequest).length,
    }),
    [rows],
  );

  const slowestMs = useMemo(
    () => Math.max(1, ...rows.map((r) => r.durationMs ?? 0)),
    [rows],
  );

  const groups = useMemo(() => (grouped ? groupByDomain(rows) : []), [grouped, rows]);

  async function reboot(enable: boolean) {
    setRebooting(true);
    setRebootError(null);
    try {
      const response = await fetch(
        `${bodyBase}/reboot?device=${encodeURIComponent(udid)}&enabled=${enable ? "1" : "0"}`,
        { method: "POST", headers: captureAuthHeaders({ json: true }), body: "{}" },
      );
      if (!response.ok) {
        // Shutdown can succeed before boot fails, so silence here leaves the panel describing a device
        // that is now off.
        const detail = await response
          .json()
          .then((body: { error?: string }) => body.error)
          .catch(() => null);
        setRebootError(detail ?? `The device could not be rebooted (HTTP ${response.status}).`);
        return;
      }
      setMeta((await response.json()) as CaptureMeta);
      setStreamKey((key) => key + 1);
    } catch (error) {
      setRebootError(
        error instanceof Error ? error.message : "The reboot request could not be sent.",
      );
    } finally {
      setRebooting(false);
    }
  }

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      summaryClassName="grid [grid-template-columns:auto_1fr_auto_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">
            Network requests
          </span>
          {errored ? (
            <span className="group relative justify-self-end inline-flex items-center" role="status">
              <TriangleAlert aria-hidden="true" className="w-3.5 h-3.5 text-amber-400" />
              <span className="sr-only">The capture stream disconnected</span>
              <span className="pointer-events-none absolute right-0 top-full z-10 mt-1 hidden w-max max-w-[220px] rounded-md bg-black/90 px-2 py-1 text-[11px] leading-snug text-white/90 shadow-lg group-hover:block">
                The capture stream disconnected
              </span>
            </span>
          ) : (
            <span />
          )}
          <span className="rounded-md border border-white/8 bg-white/[0.04] px-1.5 py-[3px] text-[10px] font-mono text-white/60">
            {rows.length}
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span
            role="status"
            aria-label={captureStatusLabel(capturing, starting, meta?.fields)}
            className={`group relative inline-flex items-center rounded p-1 ${
              capturing
                ? "bg-emerald-500/15 text-emerald-300"
                : starting
                  ? "bg-sky-500/15 text-sky-300"
                  : "bg-amber-500/15 text-amber-300"
            }`}
          >
            <Radio aria-hidden="true" className="w-3.5 h-3.5" />
            <span className="pointer-events-none absolute left-0 top-full z-10 mt-1 hidden w-max max-w-[240px] rounded-md bg-black/90 px-2 py-1 text-[11px] leading-snug text-white/90 shadow-lg group-hover:block">
              <CaptureStatusTooltip capturing={capturing} starting={starting} fields={meta?.fields} />
            </span>
          </span>
          <button
            type="button"
            disabled={rebootButton.disabled}
            onClick={() => void reboot(!captureOn)}
            className="rounded px-2 py-1 text-[11px] text-white/60 hover:bg-white/10 disabled:opacity-50"
          >
            {rebootButton.label}
          </button>
        </div>

        {rebootError && (
          <span className="whitespace-pre-line text-[11px] leading-snug text-red-300">
            {rebootError}
          </span>
        )}

        <CaptureState
          attachment={meta?.attachment ?? "not-enabled"}
          attachError={meta?.attachError ?? null}
        />

        <OversizedBodiesNotice count={meta?.droppedOversizedBodies ?? 0} />

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
                aria-label="Download live window as HAR"
                title="Download live window as HAR"
                className="rounded p-1 text-white/40 hover:bg-white/10"
                onClick={() => {
                  void (async () => {
                    try {
                      const response = await fetch(harUrl, { headers: captureAuthHeaders() });
                      if (!response.ok) return;
                      const blob = await response.blob();
                      const objectUrl = URL.createObjectURL(blob);
                      const anchor = document.createElement("a");
                      anchor.href = objectUrl;
                      anchor.download = `serve-sim-${udid.slice(0, 8)}.har`;
                      anchor.click();
                      URL.revokeObjectURL(objectUrl);
                    } catch {
                      // Ignore download failures.
                    }
                  })();
                }}
              >
                <Download aria-hidden="true" className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                aria-label="Clear the live request list"
                title="Clear the live request list (session HAR on disk is kept)"
                onClick={clear}
                className="rounded p-1 text-white/40 hover:bg-white/10"
              >
                <Ban aria-hidden="true" className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="thin-scroll max-h-64 overflow-y-auto pr-1.5 border-t border-white/5">
              {rows.length === 0 ? (
                <span className="block py-2 text-[11px] text-white/40">
                  {filter ? "No requests match that filter." : "No requests captured yet."}
                </span>
              ) : grouped ? (
                groups.map((group) => (
                  <DomainSection
                    key={group.host}
                    group={group}
                    bodyBase={bodyBase}
                    udid={udid}
                    slowestMs={slowestMs}
                  />
                ))
              ) : (
                rows.map((request) => (
                  <RequestRow
                    key={request.id}
                    request={request}
                    bodyBase={bodyBase}
                    udid={udid}
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
 * Reboot is the only remedy the panel offers, so it is disabled only while a reboot is genuinely
 * mid-flight. A stream that failed sets `errored` and must leave the button live — reporting a problem
 * and disabling its fix is the worst of both.
 */
export function rebootControl({
  meta,
  errored,
  rebooting,
}: {
  meta: CaptureMeta | null;
  errored: boolean;
  rebooting: boolean;
}): { disabled: boolean; label: string } {
  if (rebooting) return { disabled: true, label: "Rebooting…" };
  if (meta === null) {
    return errored
      ? { disabled: false, label: "Reboot with capture" }
      : { disabled: true, label: "Reboot with capture" };
  }
  if (meta.attachment === "starting") return { disabled: true, label: "Starting…" };
  return {
    disabled: false,
    label: meta.attachment === "capturing" ? "Reboot without capture" : "Reboot with capture",
  };
}

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

function responseBodiesEnabled(fields: string[] | undefined): boolean {
  return !!fields?.includes("response-body");
}

export function captureStatusLabel(
  capturing: boolean,
  starting: boolean,
  fields: string[] | undefined,
): string {
  if (starting) return "Capture starting";
  if (!capturing) return "Capture disabled";
  if (responseBodiesEnabled(fields)) return "Capture enabled";
  return "Capture enabled. Response bodies not captured.";
}

export function CaptureStatusTooltip({
  capturing,
  starting,
  fields,
}: {
  capturing: boolean;
  starting: boolean;
  fields: string[] | undefined;
}) {
  if (starting) return <>Capture starting</>;
  if (!capturing) return <>Capture disabled</>;
  if (responseBodiesEnabled(fields)) return <>Capture enabled</>;
  return (
    <>
      Capture enabled
      <span className="mt-0.5 block text-white/55">Response bodies not captured</span>
    </>
  );
}

/** Shown when mitm control POSTs were dropped for exceeding the body cap. */
export function OversizedBodiesNotice({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="flex items-start gap-1.5 text-[11px] leading-snug text-amber-400/80">
      <TriangleAlert aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
      Dropped {count} oversized capture post{count === 1 ? "" : "s"} (over the control-body limit).
      Check the serve-sim terminal for `[capture] Dropped oversized control body`, or raise{" "}
      <code className="text-amber-300/90">SERVE_SIM_CAPTURE_MAX_CONTROL_BODY_BYTES</code>.
    </span>
  );
}

export function DomainSection({
  group,
  bodyBase,
  udid,
  slowestMs,
}: {
  group: DomainGroup;
  bodyBase: string;
  udid: string;
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
            <RequestRow
              key={request.id}
              request={request}
              bodyBase={bodyBase}
              udid={udid}
              slowestMs={slowestMs}
            />
          ))}
        </div>
      )}
    </div>
  );
}

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

function Fact({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <>
      <span className="text-white/30">{label}</span>
      <span className="text-white/70 tabular-nums">{value}</span>
    </>
  );
}

export function RequestFacts({ request }: { request: CapturedRequest }) {
  const wait = request.ttfbMs;
  const total = request.durationMs;
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 text-[10px]">
      <Fact label="Method" value={request.method} />
      <Fact label="Type" value={request.mimeType} />
      <Fact label="Sent" value={request.requestBytes > 0 ? formatBytes(request.requestBytes) : null} />
      <Fact label="Received" value={request.responseBytes > 0 ? formatBytes(request.responseBytes) : null} />
      <Fact label="Waiting" value={wait !== null ? formatMs(wait) : null} />
      <Fact label="Total" value={total !== null ? formatMs(total) : null} />
    </div>
  );
}

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

export function RequestRow({
  request,
  bodyBase,
  udid,
  slowestMs,
}: {
  request: CapturedRequest;
  bodyBase: string;
  udid: string;
  slowestMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [body, setBody] = useState<CapturedBody | null>(null);
  const [loading, setLoading] = useState(false);
  const { host, path } = splitUrl(request.url);
  const payload = Math.max(request.requestBytes, request.responseBytes);

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (!next || body || loading) return;
    setLoading(true);
    setBody(await fetchCapturedBody(bodyBase, request.id, udid));
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

