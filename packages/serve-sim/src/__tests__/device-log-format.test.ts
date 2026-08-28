import { describe, expect, test } from "bun:test";
import {
  deviceLogMatches,
  isDeviceLogError,
  parseDeviceLogEntry,
  parseDeviceLogJson,
} from "../client/utils/device-log-format";

const sample = {
  processImagePath: "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS.simruntime/Contents/Resources/RuntimeRoot/System/Library/CoreServices/SpringBoard.app/SpringBoard",
  senderImagePath: "/usr/lib/libobjc.A.dylib",
  subsystem: "com.apple.SpringBoard",
  category: "Icon",
  eventMessage: "icon layout changed",
  messageType: "Default",
};

describe("parseDeviceLogEntry", () => {
  test("reads process basename, subsystem, and message", () => {
    expect(parseDeviceLogEntry(sample)).toEqual({
      process: "SpringBoard",
      subsystem: "com.apple.SpringBoard",
      category: "Icon",
      message: "icon layout changed",
      level: "default",
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
      subsystem: "",
      category: "",
      message: "hello",
      level: "error",
    });
  });

  test("drops entries with no eventMessage", () => {
    expect(parseDeviceLogEntry({ processImagePath: "/SpringBoard", eventMessage: "" })).toBeNull();
    expect(parseDeviceLogEntry(null)).toBeNull();
    expect(parseDeviceLogEntry("not json object")).toBeNull();
  });
});

describe("parseDeviceLogJson", () => {
  test("parses an ndjson line", () => {
    expect(parseDeviceLogJson(JSON.stringify(sample))?.process).toBe("SpringBoard");
  });

  test("returns null for malformed json", () => {
    expect(parseDeviceLogJson("{")).toBeNull();
  });
});

describe("deviceLogMatches", () => {
  const line = parseDeviceLogEntry(sample)!;

  test("empty query matches", () => {
    expect(deviceLogMatches(line, "")).toBe(true);
    expect(deviceLogMatches(line, "  ")).toBe(true);
  });

  test("matches process, subsystem, category, or message", () => {
    expect(deviceLogMatches(line, "spring")).toBe(true);
    expect(deviceLogMatches(line, "ICON")).toBe(true);
    expect(deviceLogMatches(line, "layout")).toBe(true);
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
