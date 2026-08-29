import { describe, expect, test } from "bun:test";
import { logsSnapshotUrl, parseLogSnapshot } from "../client/utils/logs-poll";

const raw = JSON.stringify({
  timestamp: "2026-08-28 12:54:11.123456-0700",
  processImagePath: "/SpringBoard.app/SpringBoard",
  eventMessage: "hello",
  messageType: "Default",
  processID: 1,
});

describe("logsSnapshotUrl", () => {
  test("asks for a JSON follow snapshot, not SSE", () => {
    const url = logsSnapshotUrl("/logs?device=UDID", 0);
    const params = new URL(url, "http://127.0.0.1").searchParams;
    expect(params.get("snapshot")).toBe("1");
    expect(params.get("follow")).toBe("1");
    expect(params.get("since")).toBeNull();
    expect(params.get("limit")).toBe("400");
    expect(params.get("envelope")).toBeNull();
  });

  test("resumes from a cursor with a larger page", () => {
    const url = logsSnapshotUrl("/.sim/logs?device=UDID", 12);
    const params = new URL(url, "http://127.0.0.1").searchParams;
    expect(params.get("since")).toBe("12");
    expect(params.get("limit")).toBe("800");
    expect(url.startsWith("/.sim/logs?")).toBe(true);
  });
});

describe("parseLogSnapshot", () => {
  test("keeps parseable lines and the server cursor", () => {
    const parsed = parseLogSnapshot({
      latestSeq: 4,
      lines: [
        { seq: 3, raw },
        { seq: 4, raw: "not-json" },
        { seq: 5 },
      ],
    });
    expect(parsed.latestSeq).toBe(4);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]?.seq).toBe(3);
    expect(parsed.lines[0]?.fields.message).toBe("hello");
  });

  test("treats a malformed payload as empty", () => {
    expect(parseLogSnapshot(null)).toEqual({ latestSeq: 0, lines: [] });
    expect(parseLogSnapshot("nope")).toEqual({ latestSeq: 0, lines: [] });
  });
});
