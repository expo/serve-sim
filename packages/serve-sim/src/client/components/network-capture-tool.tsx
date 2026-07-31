import { ChevronDown, ChevronRight, Radio, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";

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

/** Status colour: 2xx quiet, 3xx informational, 4xx/5xx and failures loud. */
function statusClass(request: CapturedRequest): string {
  if (request.failure) return "text-red-400";
  if (request.status === null) return "text-white/40";
  if (request.status >= 500) return "text-red-400";
  if (request.status >= 400) return "text-amber-400";
  if (request.status >= 300) return "text-sky-400";
  return "text-emerald-400";
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

/** Live table of the app's HTTPS requests, captured through serve-sim's proxy. */
export function NetworkCaptureTool({ udid, captureEndpoint }: { udid: string; captureEndpoint?: string }) {
  const path = useMemo(
    () => captureEndpoint ?? `${simEndpoint("network-capture")}?device=${encodeURIComponent(udid)}`,
    [captureEndpoint, udid],
  );
  const bodyBase = useMemo(() => path.split("?")[0]!, [path]);
  const [open, setOpen] = useState(true);
  const [rebooting, setRebooting] = useState(false);
  // Read-only: capture belongs to the booted device, so watching it cannot turn it on or off.
  const { meta, requests, errored, clear } = useCaptureStream(path, open);
  const capturing = meta?.attachment === "capturing";

  const reboot = async (enable: boolean) => {
    setRebooting(true);
    try {
      await fetch(`${bodyBase}/reboot?device=${encodeURIComponent(udid)}&enabled=${enable ? "1" : "0"}`, {
        method: "POST",
      });
    } finally {
      setRebooting(false);
    }
  };

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
            <span className="text-[11px] text-white/40 tabular-nums text-right">{requests.length}</span>
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
            {capturing ? "Intercepted" : "Not capturing"}
          </span>
          <button
            type="button"
            disabled={rebooting}
            onClick={() => void reboot(!capturing)}
            className="rounded px-2 py-1 text-[11px] text-white/60 hover:bg-white/10 disabled:opacity-50"
          >
            {rebooting ? "Rebooting…" : capturing ? "Reboot without capture" : "Reboot with capture"}
          </button>
          {requests.length > 0 && (
            <button
              type="button"
              onClick={clear}
              className="rounded px-2 py-1 text-[11px] text-white/50 hover:bg-white/10"
            >
              Clear
            </button>
          )}
        </div>

        <ProxyHint
          address={meta?.proxyAddress ?? null}
          attachment={meta?.attachment ?? "not-enabled"}
          attachError={meta?.attachError ?? null}
        />

        {capturing &&
          (requests.length === 0 ? (
            <span className="text-[11px] text-white/40">No requests captured yet.</span>
          ) : (
            <div className="flex flex-col divide-y divide-white/5">
              {requests.map((request) => (
                <RequestRow key={request.id} request={request} bodyBase={bodyBase} />
              ))}
            </div>
          ))}
      </div>
    </CollapsibleSection>
  );
}

/**
 * Whether this device is capturing, and why not when it isn't.
 *
 * Reporting the reason is the whole point: an empty list with a healthy-looking proxy address is
 * indistinguishable from an app that made no requests.
 */
function ProxyHint({
  address,
  attachment,
  attachError,
}: {
  address: string | null;
  attachment: CaptureAttachment;
  attachError: string | null;
}) {
  // A failed session has no address, so this has to be checked first: otherwise the reason capture
  // could not start — a missing mitmproxy, a refused certificate — is replaced by a spinner that never
  // resolves, which is the one outcome worse than the failure itself.
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
  if (attachment === "not-enabled" || !address) {
    return (
      <span className="whitespace-pre-line text-[11px] leading-snug text-white/40">
        {attachError ?? "This device is not capturing."}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-white/50">
        Proxy <span className="tabular-nums text-white/80">{address}</span>
      </span>
      <span className="text-[10px] leading-snug text-amber-400/80">
        Every app on this device has its HTTPS traffic decrypted and read. Apps that pin their certificate
        will refuse to connect until this device is rebooted without capture.
      </span>
    </div>
  );
}

/** A body the proxy reported as binary. Naming it beats rendering it as replacement characters. */
function BinaryNote({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-white/30">{label}</span>
      <span className="text-[11px] text-white/40">Binary body — not shown.</span>
    </div>
  );
}

/** One request; expanding it fetches the headers and bodies the stream leaves out. */
function RequestRow({ request, bodyBase }: { request: CapturedRequest; bodyBase: string }) {
  const [expanded, setExpanded] = useState(false);
  const [body, setBody] = useState<CapturedBody | null>(null);
  const [loading, setLoading] = useState(false);
  const { host, path } = splitUrl(request.url);

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (!next || body || loading) return;
    setLoading(true);
    setBody(await fetchCapturedBody(bodyBase, request.id));
    setLoading(false);
  }

  return (
    <div className="py-1">
      <button type="button" onClick={toggle} className="w-full text-left flex items-baseline gap-2">
        {expanded ? (
          <ChevronDown aria-hidden="true" className="w-3 h-3 mt-0.5 shrink-0 text-white/30" />
        ) : (
          <ChevronRight aria-hidden="true" className="w-3 h-3 mt-0.5 shrink-0 text-white/30" />
        )}
        <span className={`text-[11px] tabular-nums shrink-0 ${statusClass(request)}`}>
          {request.failure ? "err" : (request.status ?? "···")}
        </span>
        <span className="text-[11px] text-white/40 shrink-0">{request.method}</span>
        <span className="text-[11px] text-white/80 truncate flex-1" title={request.url}>
          {path}
        </span>
        <span className="text-[10px] text-white/30 tabular-nums shrink-0">
          {request.durationMs !== null ? `${request.durationMs}ms` : ""}
        </span>
      </button>
      {expanded && (
        <div className="pl-5 pt-1 flex flex-col gap-1 text-[10px] text-white/50">
          <span className="text-white/40">{host}</span>
          <span className="tabular-nums">
            {formatBytes(request.requestBytes)} sent · {formatBytes(request.responseBytes)} received
            {request.ttfbMs !== null && ` · ${request.ttfbMs}ms to first byte`}
            {request.mimeType && ` · ${request.mimeType}`}
          </span>
          {request.failure && <span className="text-red-400">{request.failure}</span>}
          {loading && <span>Loading body…</span>}
          {body && <BodyDetail body={body} />}
          {!loading && !body && !request.failure && <span className="text-white/30">No body recorded.</span>}
        </div>
      )}
    </div>
  );
}

/** Headers and bodies for an expanded row, truncation called out where it happened. */
function BodyDetail({ body }: { body: CapturedBody }) {
  return (
    <div className="flex flex-col gap-1">
      <HeaderList label="Request headers" headers={body.requestHeaders} />
      {body.requestBinary ? (
        <BinaryNote label="Request body" />
      ) : (
        body.requestBody && (
          <BodyBlock label="Request body" text={body.requestBody} truncated={body.requestTruncated} />
        )
      )}
      <HeaderList label="Response headers" headers={body.responseHeaders} />
      {body.responseBinary ? (
        <BinaryNote label="Response body" />
      ) : (
        body.responseBody && (
          <BodyBlock label="Response body" text={body.responseBody} truncated={body.responseTruncated} />
        )
      )}
    </div>
  );
}

function HeaderList({ label, headers }: { label: string; headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col">
      <span className="text-white/40">{label}</span>
      {entries.map(([name, value]) => (
        <span key={name} className="truncate" title={`${name}: ${value}`}>
          <span className="text-white/40">{name}:</span> {value}
        </span>
      ))}
    </div>
  );
}

function BodyBlock({ label, text, truncated }: { label: string; text: string; truncated: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-white/40">
        {label}
        {truncated && <span className="text-amber-400/70"> (truncated)</span>}
      </span>
      <pre className="whitespace-pre-wrap break-all max-h-40 overflow-auto bg-black/30 rounded px-1.5 py-1">
        {text}
      </pre>
    </div>
  );
}
