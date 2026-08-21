import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StreamStatsBody, isScaledDown, statsToJson } from "../client/components/stream-stats-tool";
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
    jitterBufferMs: 40,
    reportedFps: 60,
    width: 1280,
    height: 720,
    codec: "video/VP8",
    roundTripMs: 30,
    availableIncomingKbps: 3000,
    path: "direct",
    fps: 60,
    kbps: 2800,
    lossRatio: 0,
    droppedInWindow: 0,
    freezesInWindow: 0,
    ...overrides,
  };
}

describe("isScaledDown", () => {
  test("spots a picture smaller than the one that was asked for", () => {
    expect(isScaledDown(stats({ width: 640, height: 360 }), 1280)).toBe(true);
  });

  test("does not call a full-size picture scaled down", () => {
    expect(isScaledDown(stats(), 1280)).toBe(false);
  });

  test("says no when nothing was requested, rather than guessing", () => {
    expect(isScaledDown(stats({ width: 640, height: 360 }), undefined)).toBe(false);
  });
});

describe("StreamStatsBody", () => {
  test("shows the numbers a healthy stream reports", () => {
    const html = renderToStaticMarkup(<StreamStatsBody stats={stats()} requestedFps={60} />);

    expect(html).toContain("1280x720");
    expect(html).toContain("video/VP8");
    expect(html).toContain("direct");
  });

  test("flags a relayed path, which costs latency", () => {
    const html = renderToStaticMarkup(<StreamStatsBody stats={stats({ path: "relay" })} />);

    expect(html).toContain("relay");
    expect(html).toContain("text-warning");
  });

  test("says the picture was scaled down instead of just showing a smaller size", () => {
    const html = renderToStaticMarkup(
      <StreamStatsBody stats={stats({ width: 640, height: 360 })} requestedMaxDimension={1280} />,
    );

    expect(html).toContain("scaled down");
  });

  test("shows fps against the requested rate without calling a quiet screen a fault", () => {
    // Capture is event-driven with an idle floor, so low fps on a static screen is correct behaviour.
    const html = renderToStaticMarkup(<StreamStatsBody stats={stats({ fps: 5 })} requestedFps={60} />);

    expect(html).toContain("5 / 60");
    expect(html).not.toContain("text-warning");
  });

  test("still flags the unambiguous faults", () => {
    const html = renderToStaticMarkup(
      <StreamStatsBody stats={stats({ droppedInWindow: 4, freezesInWindow: 1, lossRatio: 0.05 })} />,
    );

    expect(html).toContain("text-warning");
  });

  test("renders dashes rather than zeros when a value is unavailable", () => {
    const html = renderToStaticMarkup(
      <StreamStatsBody stats={stats({ fps: null, kbps: null, roundTripMs: null, lossRatio: null })} />,
    );

    // One dash per unavailable rate. A count of 0 for dropped frames is a real reading, not a gap.
    expect(html.split("—").length - 1).toBe(4);
  });
});

describe("statsToJson", () => {
  test("serializes the recorded window so a session can be handed over", () => {
    const parsed = JSON.parse(statsToJson([stats({ fps: 12 }), stats({ fps: 55 })])) as {
      recordedAt: string;
      samples: { fps: number }[];
    };

    expect(parsed.samples.map((s) => s.fps)).toEqual([12, 55]);
    expect(Number.isNaN(Date.parse(parsed.recordedAt))).toBe(false);
  });

  test("writes an empty sample list rather than failing when nothing was recorded", () => {
    expect(JSON.parse(statsToJson([])).samples).toEqual([]);
  });
});
