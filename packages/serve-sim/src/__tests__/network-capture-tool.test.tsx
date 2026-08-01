import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CaptureState,
  DomainSection,
  RequestFacts,
  RequestRow,
  TimingBar,
  formatMs,
  groupByDomain,
} from "../client/components/network-capture-tool";
import { type CapturedRequest } from "../capture-store";

function request(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    id: "r1",
    method: "GET",
    url: "https://speed.cloudflare.com/__down?bytes=10000000",
    status: 200,
    mimeType: "application/octet-stream",
    requestBytes: 0,
    responseBytes: 9_500_000,
    startedAt: 0,
    ttfbMs: 31,
    durationMs: 171,
    failure: null,
    ...overrides,
  };
}

const row = (overrides: Partial<CapturedRequest> = {}, slowestMs = 171) =>
  renderToStaticMarkup(
    <RequestRow request={request(overrides)} bodyBase="/network-capture" slowestMs={slowestMs} />,
  );

describe("RequestRow", () => {
  test("fits status, path, payload, method, host, and duration without wrapping", () => {
    const html = row();

    expect(html).toContain("200");
    expect(html).toContain("/__down?bytes=10000000");
    expect(html).toContain("GET");
    expect(html).toContain("speed.cloudflare.com");
    expect(html).toContain("9.1 MB");
    expect(html).toContain("171ms");
    // The timing split lives in the expanded detail; in the row it wrapped at the panel's real width.
    expect(html).not.toContain("wait 31ms");
    expect(html).not.toContain("transfer");
  });

  test("reports the payload from whichever direction carried it", () => {
    // An upload's bytes are all outbound, so a row showing only what came back reads as empty.
    const html = row({ method: "POST", requestBytes: 1_900_000, responseBytes: 0 });

    expect(html).toContain("1.8 MB");
    expect(html).toContain("POST");
  });

  test("marks a failed request in the row, with the reason kept for the detail", () => {
    const html = row({
      status: null,
      failure: "The app rejected our certificate, which means it pins its own.",
      ttfbMs: null,
      durationMs: 2100,
    });

    expect(html).toContain("err");
    expect(html).toContain("2.1s");
  });

  test("keeps an in-flight request readable before it settles", () => {
    const html = row({ status: null, ttfbMs: null, durationMs: null, responseBytes: 0 });

    expect(html).toContain("···");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });
});

describe("TimingBar", () => {
  test("scales the wait and transfer segments against the slowest request on screen", () => {
    const html = renderToStaticMarkup(
      <TimingBar request={request({ ttfbMs: 100, durationMs: 200 })} slowestMs={400} />,
    );

    // 100ms of 400ms waiting, then 100ms transferring.
    expect(html).toContain("width:25%");
  });

  test("never exceeds the track, even when a request outlasts the window's slowest", () => {
    const html = renderToStaticMarkup(
      <TimingBar request={request({ ttfbMs: 900, durationMs: 900 })} slowestMs={100} />,
    );

    const widths = [...html.matchAll(/width:(\d+(?:\.\d+)?)%/g)].map((match) => Number(match[1]));
    expect(Math.max(...widths)).toBeLessThanOrEqual(100);
  });

  test("draws a failure as one bar rather than a split it does not have", () => {
    const html = renderToStaticMarkup(
      <TimingBar request={request({ failure: "connection refused", durationMs: 50 })} slowestMs={100} />,
    );

    expect(html).toContain("bg-red-400/50");
    expect(html).not.toContain("bg-sky-400/60");
  });
});

describe("groupByDomain", () => {
  test("collects requests per host, summing bytes and counting failures", () => {
    const groups = groupByDomain([
      request({ id: "r1", url: "https://a.test/one", responseBytes: 100 }),
      request({ id: "r2", url: "https://b.test/two", responseBytes: 50, requestBytes: 10 }),
      request({ id: "r3", url: "https://a.test/three", responseBytes: 400, status: 502 }),
    ]);

    expect(groups.map((group) => group.host)).toEqual(["a.test", "b.test"]);
    expect(groups[0]!.requests).toHaveLength(2);
    expect(groups[0]!.bytes).toBe(500);
    expect(groups[0]!.failed).toBe(1);
    expect(groups[1]!.bytes).toBe(60);
    expect(groups[1]!.failed).toBe(0);
  });

  test("counts a transport failure as failed even without a status", () => {
    const groups = groupByDomain([
      request({ url: "https://a.test/x", status: null, failure: "connection refused" }),
    ]);

    expect(groups[0]!.failed).toBe(1);
  });

  test("keeps an unparseable url visible under a named group", () => {
    const groups = groupByDomain([request({ url: "not-a-url" })]);

    expect(groups[0]!.host).toBe("unknown");
  });
});

describe("DomainSection", () => {
  test("shows the roll-up and stays collapsed so a busy host does not bury the rest", () => {
    const html = renderToStaticMarkup(
      <DomainSection
        group={{ host: "speed.cloudflare.com", requests: [request()], bytes: 48_000_000, failed: 0 }}
        bodyBase="/network-capture"
        slowestMs={171}
      />,
    );

    expect(html).toContain("speed.cloudflare.com");
    expect(html).toContain("45.8 MB");
    expect(html).toContain("req");
    expect(html).toContain('aria-expanded="false"');
    // Collapsed, so the rows inside are not rendered at all.
    expect(html).not.toContain("/__down?bytes=10000000");
  });

  test("surfaces failures on a collapsed host, instead of hiding them until expanded", () => {
    const html = renderToStaticMarkup(
      <DomainSection
        group={{ host: "api.example.com", requests: [request()], bytes: 0, failed: 3 }}
        bodyBase="/network-capture"
        slowestMs={171}
      />,
    );

    expect(html).toContain("3 failed");
  });
});

describe("CaptureState", () => {
  test("explains a device that was not booted with capture", () => {
    const html = renderToStaticMarkup(
      <CaptureState address={null} attachment="not-enabled" attachError="Needs a reboot with capture." />,
    );

    expect(html).toContain("Needs a reboot with capture.");
  });

  test("keeps the reason visible when capture failed, rather than showing a spinner", () => {
    const html = renderToStaticMarkup(
      <CaptureState address={null} attachment="failed" attachError="mitmproxy is not installed" />,
    );

    expect(html).toContain("mitmproxy is not installed");
  });

  test("says it is starting while a device reboots into capture", () => {
    const html = renderToStaticMarkup(
      <CaptureState address={null} attachment="starting" attachError={null} />,
    );

    expect(html).toContain("Starting capture");
  });

  test("names the proxy and warns that the whole device is intercepted", () => {
    const html = renderToStaticMarkup(
      <CaptureState address="127.0.0.1:52248" attachment="capturing" attachError={null} />,
    );

    expect(html).toContain("127.0.0.1:52248");
    // The warning is load-bearing: a pinned app will fail for as long as this device stays up.
    expect(html).toContain("pin their certificate");
  });
});

describe("RequestFacts", () => {
  test("names each figure, so nothing has to be inferred from a glyph", () => {
    const html = renderToStaticMarkup(<RequestFacts request={request({ requestBytes: 412 })} />);

    expect(html).toContain("method");
    expect(html).toContain("received");
    expect(html).toContain("sent");
    expect(html).toContain("waiting");
    expect(html).toContain("total");
    expect(html).toContain("412 B");
  });

  test("leaves out figures a request does not have, rather than showing zeroes", () => {
    const html = renderToStaticMarkup(
      <RequestFacts request={request({ requestBytes: 0, mimeType: null, ttfbMs: null })} />,
    );

    expect(html).not.toContain("sent");
    expect(html).not.toContain("type");
    expect(html).not.toContain("waiting");
  });
});

describe("formatMs", () => {
  test("switches to seconds once milliseconds stop reading well", () => {
    expect(formatMs(90)).toBe("90ms");
    expect(formatMs(999)).toBe("999ms");
    expect(formatMs(1000)).toBe("1.0s");
    expect(formatMs(2140)).toBe("2.1s");
  });
});
