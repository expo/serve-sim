import { describe, expect, test } from "bun:test";
import {
  deviceLogMatches,
  formatLogClock,
  formatLogLine,
  isDeviceLogError,
  normalizeDeviceLogLevel,
  parseDeviceLogEntry,
  parseDeviceLogJson,
  parseLogStreamFrame,
  parseLogTimestamp,
} from "../client/utils/device-log-format";

const sample = {
  timestamp: "2026-08-28 12:54:11.123456-0700",
  processImagePath:
    "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS.simruntime/Contents/Resources/RuntimeRoot/System/Library/CoreServices/SpringBoard.app/SpringBoard",
  senderImagePath: "/usr/lib/libobjc.A.dylib",
  subsystem: "com.apple.SpringBoard",
  category: "Icon",
  eventMessage: "icon layout changed",
  messageType: "Default",
  processID: 312,
};

describe("parseDeviceLogEntry", () => {
  test("reads process basename, library, pid, and message", () => {
    expect(parseDeviceLogEntry(sample)).toEqual({
      process: "SpringBoard",
      library: "libobjc.A.dylib",
      subsystem: "com.apple.SpringBoard",
      category: "Icon",
      message: "icon layout changed",
      level: "default",
      pid: 312,
      timestamp: "2026-08-28 12:54:11.123456-0700",
    });
  });

  test("falls back to senderImagePath when processImagePath is missing", () => {
    expect(
      parseDeviceLogEntry({
        senderImagePath: "/usr/lib/libobjc.A.dylib",
        eventMessage: "hello",
        messageType: "Error",
      })
    ).toEqual({
      process: "libobjc.A.dylib",
      library: "libobjc.A.dylib",
      subsystem: "",
      category: "",
      message: "hello",
      level: "error",
      pid: null,
      timestamp: "",
    });
  });

  test("drops entries with no eventMessage", () => {
    expect(parseDeviceLogEntry({ processImagePath: "/SpringBoard", eventMessage: "" })).toBeNull();
    expect(parseDeviceLogEntry(null)).toBeNull();
    expect(parseDeviceLogEntry("not json object")).toBeNull();
  });
});

describe("normalizeDeviceLogLevel", () => {
  test("maps unified-log names and os_log type codes", () => {
    expect(normalizeDeviceLogLevel("Debug")).toBe("debug");
    expect(normalizeDeviceLogLevel("Notice")).toBe("default");
    expect(normalizeDeviceLogLevel(2)).toBe("debug");
    expect(normalizeDeviceLogLevel(1)).toBe("info");
    expect(normalizeDeviceLogLevel(0)).toBe("default");
    expect(normalizeDeviceLogLevel(16)).toBe("error");
    expect(normalizeDeviceLogLevel(17)).toBe("fault");
  });
});

describe("parseLogStreamFrame", () => {
  test("reads an enveloped cursor frame", () => {
    const frame = parseLogStreamFrame(
      JSON.stringify({ seq: 9, at: 1, raw: JSON.stringify(sample) })
    );
    expect(frame?.seq).toBe(9);
    expect(frame?.fields.process).toBe("SpringBoard");
  });

  test("still reads a raw ndjson line", () => {
    expect(parseLogStreamFrame(JSON.stringify(sample))?.seq).toBe(0);
  });
});

describe("deviceLogMatches", () => {
  const line = parseDeviceLogEntry(sample)!;

  test("empty query matches", () => {
    expect(deviceLogMatches(line, "")).toBe(true);
    expect(deviceLogMatches(line, "  ")).toBe(true);
  });

  test("matches process, subsystem, category, message, library, or pid", () => {
    expect(deviceLogMatches(line, "spring")).toBe(true);
    expect(deviceLogMatches(line, "ICON")).toBe(true);
    expect(deviceLogMatches(line, "layout")).toBe(true);
    expect(deviceLogMatches(line, "libobjc")).toBe(true);
    expect(deviceLogMatches(line, "312")).toBe(true);
    expect(deviceLogMatches(line, "nope")).toBe(false);
  });
});

describe("isDeviceLogError", () => {
  test("treats error and fault as errors", () => {
    expect(isDeviceLogError("error")).toBe(true);
    expect(isDeviceLogError("fault")).toBe(true);
    expect(isDeviceLogError("default")).toBe(false);
  });
});

describe("log time", () => {
  test("parses Apple's unified-log timestamp", () => {
    const ms = parseLogTimestamp(sample.timestamp);
    expect(ms).toBeGreaterThan(0);
    expect(formatLogClock(sample.timestamp)).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  test("returns empty when the timestamp will not parse", () => {
    expect(parseLogTimestamp("")).toBeNull();
    expect(formatLogClock("not a date")).toBe("");
  });
});

describe("formatLogLine", () => {
  test("joins the fields a copy buffer wants", () => {
    const line = parseDeviceLogEntry(sample)!;
    const text = formatLogLine(line);
    expect(text).toContain("default");
    expect(text).toContain("SpringBoard [312]");
    expect(text).toContain("com.apple.SpringBoard:Icon");
    expect(text).toContain("icon layout changed");
  });
});
