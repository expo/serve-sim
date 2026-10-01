import { describe, expect, test } from "bun:test";

import { MicUsageError, parseMicArgs } from "../mic";

describe("parseMicArgs", () => {
  test("a bundle id launches the app with the mic injected", () => {
    expect(parseMicArgs(["com.acme.App"])).toEqual({
      command: { verb: "launch", bundleId: "com.acme.App", idle: undefined, build: false },
      device: undefined,
      quiet: false,
    });
  });

  test("launch takes the device, idle mode, build and quiet flags", () => {
    expect(parseMicArgs(["com.acme.App", "-d", "iPhone 17", "--passthrough", "--build", "-q"])).toEqual({
      command: { verb: "launch", bundleId: "com.acme.App", idle: "passthrough", build: true },
      device: "iPhone 17",
      quiet: true,
    });
  });

  test("say joins the remaining words into one utterance", () => {
    expect(parseMicArgs(["say", "add", "milk", "--voice", "Samantha", "--rate", "180", "--wait"]).command)
      .toEqual({
        verb: "say",
        text: "add milk",
        voice: "Samantha",
        rate: 180,
        preRollMs: 0,
        wait: true,
      });
  });

  test("play resolves the file path and reads pre-roll", () => {
    const parsed = parseMicArgs(["play", "clip.mp3", "--pre-roll", "500"]);
    expect(parsed.command).toMatchObject({ verb: "play", preRollMs: 500, wait: false });
    expect((parsed.command as { path: string }).path).toEndWith("/clip.mp3");
    expect((parsed.command as { path: string }).path.startsWith("/")).toBe(true);
  });

  test("simple verbs parse without arguments", () => {
    for (const verb of ["stop", "status", "off", "voices"] as const) {
      expect(parseMicArgs([verb]).command).toEqual({ verb });
    }
    expect(parseMicArgs(["idle", "passthrough"]).command).toEqual({ verb: "idle", mode: "passthrough" });
    expect(parseMicArgs(["--help"]).command).toEqual({ verb: "help" });
    expect(parseMicArgs([]).command).toEqual({ verb: "help" });
  });

  test("rejects bad input with a usage error", () => {
    expect(() => parseMicArgs(["say"])).toThrow(MicUsageError);
    expect(() => parseMicArgs(["play"])).toThrow(MicUsageError);
    expect(() => parseMicArgs(["idle", "loud"])).toThrow(MicUsageError);
    expect(() => parseMicArgs(["play", "a.wav", "--pre-roll", "-5"])).toThrow(MicUsageError);
    expect(() => parseMicArgs(["say", "hi", "--rate", "fast"])).toThrow(MicUsageError);
    expect(() => parseMicArgs(["com.acme.App", "--frobnicate"])).toThrow(MicUsageError);
    expect(() => parseMicArgs(["-d"])).toThrow(MicUsageError);
  });
});
