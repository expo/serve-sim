import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StreamStatsBody, describeFaults, statsToJson } from "../client/components/stream-stats-tool";
import type { StreamStats } from "../client/utils/webrtc-stats";

function stats(overrides: Partial<StreamStats> = {}): StreamStats {
  return {
    atMs: 0,
    framesDecoded: 0,
    framesDropped: 0,
    freezeCount: 0,
    freezeMs: 0,
    bytesReceived: 0,
    packetsReceived: 0,
    packetsLost: 0,
    jitterMs: 8,
    jitterBufferSeconds: 4,
    jitterBufferEmitted: 100,
    reportedFps: 60,
    width: 1280,
    height: 720,
    codec: "video/VP8",
    roundTripMs: 30,
    path: "direct",
    fps: 60,
    kbps: 2800,
    lossRatio: 0,
    droppedInWindow: 0,
    freezesInWindow: 0,
    freezeMsInWindow: 0,
    jitterBufferMs: 40,
    ...overrides,
  };
}

/** The value shown for one labelled row, so a styling change does not read as a regression. */
function row(markup: string, label: string): string | null {
  const attribute = markup.indexOf(`data-stream-stat="${label}"`);
  if (attribute === -1) return null;
  const start = markup.indexOf(">", attribute) + 1;
  const cell = markup.slice(start, markup.indexOf("</div>", start));
  const text = cell.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.startsWith(label) ? text.slice(label.length).trim() : text;
}

describe("describeFaults", () => {
  test("says nothing about a healthy window", () => {
    expect(describeFaults(stats())).toEqual([]);
  });

  test("counts freezes with the time lost in the same window", () => {
    expect(describeFaults(stats({ freezesInWindow: 2, freezeMsInWindow: 1_500 })))
      .toEqual(["2 freezes (1.5s)"]);
  });

  test("uses the singular for one freeze", () => {
    expect(describeFaults(stats({ freezesInWindow: 1, freezeMsInWindow: 400 })))
      .toEqual(["1 freeze (0.4s)"]);
  });

  test("omits the duration when only the count is known", () => {
    expect(describeFaults(stats({ freezesInWindow: 1, freezeMsInWindow: 0 })))
      .toEqual(["1 freeze"]);
  });

  test("reports dropped frames", () => {
    expect(describeFaults(stats({ droppedInWindow: 12 }))).toEqual(["12 frames dropped"]);
  });

  test("ignores packet loss below the threshold", () => {
    expect(describeFaults(stats({ lossRatio: 0.01 }))).toEqual([]);
  });

  test("reports packet loss above the threshold", () => {
    expect(describeFaults(stats({ lossRatio: 0.05 }))).toEqual(["5.0% packet loss"]);
  });

  test("says nothing when a reading is unavailable", () => {
    expect(describeFaults(stats({
      freezesInWindow: null,
      droppedInWindow: null,
      lossRatio: null,
    }))).toEqual([]);
  });

  test("lists every fault at once", () => {
    expect(describeFaults(stats({ freezesInWindow: 1, droppedInWindow: 4, lossRatio: 0.1 })))
      .toHaveLength(3);
  });
});

describe("StreamStatsBody", () => {
  test("keeps a healthy window quiet rather than printing zeros", () => {
    const markup = renderToStaticMarkup(<StreamStatsBody stats={stats()} history={[stats()]} faults={describeFaults(stats())} />);
    expect(markup).toContain("No drops, freezes or loss in this window");
    expect(markup).not.toContain("text-warning");
  });

  test("does not claim health for a window it could not measure", () => {
    const unmeasured = stats({
      fps: null, kbps: null, lossRatio: null, droppedInWindow: null,
      freezesInWindow: null, freezeMsInWindow: null,
    });
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={unmeasured} history={[unmeasured]} faults={describeFaults(unmeasured)} />,
    );
    expect(markup).toContain("Measuring…");
    expect(markup).not.toContain("No drops");
  });

  test("leaves an unmeasured window out of the graph instead of plotting a zero", () => {
    const history = [stats({ fps: 30 }), stats({ fps: null }), stats({ fps: 30 })];
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats()} history={history} faults={[]} />,
    );
    // Two real points draw a flat line; a coalesced zero between them would dip to the baseline.
    expect(markup).not.toContain("24.0");
  });

  test("shows a fractional frame rate so a limping stream is not a dead one", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats({ fps: 0.4 })} history={[stats()]} faults={describeFaults(stats({ fps: 0.4 }))} />,
    );
    expect(row(markup, "Frame rate")).toBe("0.4 fps");
  });

  test("shows the faults instead of the all-clear line", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats({ droppedInWindow: 3 })} history={[stats()]} faults={describeFaults(stats({ droppedInWindow: 3 }))} />,
    );
    expect(markup).toContain("3 frames dropped");
    expect(markup).toContain("text-warning");
    expect(markup).not.toContain("No drops");
  });

  test("renders a dash without its unit when a reading is unavailable", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody
        stats={stats({ fps: null, kbps: null, roundTripMs: null, jitterBufferMs: null })}
        history={[stats()]}
        faults={[]}
      />,
    );
    expect(row(markup, "Frame rate")).toBe("—");
    expect(row(markup, "Bitrate")).toBe("—");
    expect(row(markup, "Round trip")).toBe("—");
    expect(row(markup, "Buffer")).toBe("—");
    expect(markup).not.toContain("— ms");
  });

  test("shows the frame rate against the requested one", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats({ fps: 24 })} history={[stats()]} faults={describeFaults(stats({ fps: 24 }))} requestedFps={60} />,
    );
    expect(row(markup, "Frame rate")).toBe("24 fps of 60");
  });

  test("keeps a limping stream distinguishable from a dead one", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats({ kbps: 4 })} history={[stats()]} faults={describeFaults(stats({ kbps: 4 }))} />,
    );
    expect(row(markup, "Bitrate")).toBe("4 kbps");
  });

  test("names a relayed route in words rather than an ICE term", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats({ path: "relay" })} history={[stats()]} faults={describeFaults(stats({ path: "relay" }))} />,
    );
    expect(row(markup, "Route")).toBe("Via relay");
  });

  test("hides the route when it cannot be determined", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats({ path: "unknown" })} history={[stats()]} faults={describeFaults(stats({ path: "unknown" }))} />,
    );
    expect(row(markup, "Route")).toBeNull();
  });

  test("draws a sparkline from the recorded values, not an empty box", () => {
    const history = [stats({ fps: 10, kbps: 500 }), stats({ fps: 60, kbps: 2_800 })];
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats()} history={history} faults={[]} />,
    );
    const paths = [...markup.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]);
    expect(paths).toHaveLength(4);
    // Two different series must not draw the same shape.
    expect(new Set(paths).size).toBeGreaterThan(1);
  });
});

describe("statsToJson", () => {
  test("records the session context, so the file explains itself", () => {
    const parsed = JSON.parse(statsToJson([stats()], { transport: "webrtc", codec: "video/VP8" }));
    expect(parsed.transport).toBe("webrtc");
    expect(parsed.codec).toBe("video/VP8");
    expect(parsed.samples).toHaveLength(1);
    expect(typeof parsed.recordedAt).toBe("string");
  });
});
