import { describe, expect, test, beforeEach } from "bun:test";
import {
  clearEventLogForTests,
  eventLogEventForCommand,
  eventLogEventForHidMessage,
  readEventLog,
  recordEventLogEvent,
  subscribeEventLog,
} from "../event-log";

beforeEach(() => {
  clearEventLogForTests();
});

describe("event log store", () => {
  test("records entries in order and filters by device", () => {
    recordEventLogEvent({
      device: "DEVICE-A",
      source: "hid",
      kind: "button",
      action: "home",
      summary: "Home",
    });
    recordEventLogEvent({
      device: "DEVICE-B",
      source: "hid",
      kind: "button",
      action: "volume-up",
      summary: "Button volume-up",
    });

    expect(readEventLog().map((event) => event.id)).toEqual([1, 2]);
    expect(readEventLog({ device: "DEVICE-B" }).map((event) => event.summary)).toEqual([
      "Button volume-up",
    ]);
  });

  test("supports since and limit reads", () => {
    for (let i = 0; i < 5; i++) {
      recordEventLogEvent({
        source: "exec",
        kind: "button",
        summary: `Event ${i}`,
      });
    }

    expect(readEventLog({ sinceId: 2 }).map((event) => event.id)).toEqual([3, 4, 5]);
    expect(readEventLog({ limit: 2 }).map((event) => event.id)).toEqual([4, 5]);
  });

  test("notifies subscribers as entries are recorded", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeEventLog((event) => seen.push(event.summary));
    recordEventLogEvent({ source: "exec", kind: "button", summary: "Home" });
    unsubscribe();
    recordEventLogEvent({ source: "exec", kind: "button", summary: "Ignored" });
    expect(seen).toEqual(["Home"]);
  });
});

describe("eventLogEventForHidMessage", () => {
  test("maps button HID payloads", () => {
    expect(
      eventLogEventForHidMessage("UDID", 0x04, {
        button: "volume-up",
        page: 12,
        usage: 233,
        phase: "down",
      }),
    ).toMatchObject({
      device: "UDID",
      source: "hid",
      kind: "button",
      action: "volume-up",
      summary: "Button volume-up down",
    });
  });

  test("maps touch payloads with screen details", () => {
    expect(
      eventLogEventForHidMessage("UDID", 0x03, { type: "begin", x: 0.5, y: 0.9 }, {
        width: 390,
        height: 844,
      }),
    ).toMatchObject({
      device: "UDID",
      source: "hid",
      kind: "touch",
      action: "begin",
      summary: "Touch begin 0.5,0.9",
      details: { screen: { width: 390, height: 844 } },
    });
  });
});

describe("eventLogEventForCommand", () => {
  test("classifies app installs without logging upload chunks", () => {
    expect(eventLogEventForCommand("bash -c 'echo abc= | base64 -d > /tmp/app.ipa'")).toBeNull();
    expect(
      eventLogEventForCommand("xcrun simctl install DEVICE-A /tmp/MyApp.ipa", { exitCode: 0 }),
    ).toMatchObject({
      device: "DEVICE-A",
      source: "exec",
      kind: "app",
      action: "install",
      status: "ok",
      summary: "Install app MyApp.ipa",
    });
  });

  test("classifies toolbar home and screenshot commands", () => {
    expect(
      eventLogEventForCommand("xcrun simctl launch DEVICE-A com.apple.springboard", { exitCode: 0 }),
    ).toMatchObject({
      device: "DEVICE-A",
      kind: "button",
      action: "home",
      summary: "Home",
    });
    expect(
      eventLogEventForCommand("xcrun simctl io DEVICE-A screenshot ~/Desktop/shot.png", { exitCode: 1 }),
    ).toMatchObject({
      device: "DEVICE-A",
      kind: "screenshot",
      status: "error",
      summary: "Screenshot",
    });
  });

  test("classifies serve-sim commands invoked through node", () => {
    expect(
      eventLogEventForCommand("node /tmp/dist/serve-sim.js button volume-up -d DEVICE-A"),
    ).toMatchObject({
      device: "DEVICE-A",
      kind: "button",
      action: "volume-up",
      summary: "Button volume-up",
    });
  });
});
