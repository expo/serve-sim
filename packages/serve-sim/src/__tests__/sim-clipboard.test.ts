import { describe, expect, test } from "bun:test";
import { HID_USAGE_BY_CODE } from "../client/utils/hid";
import {
  PBCOPY_INLINE_MAX,
  copyTextToSim,
  pbcopyCommand,
  readSimClipboard,
  simCopyHidEvents,
  simPasteHidEvents,
  simSelectAllHidEvents,
} from "../client/utils/sim-clipboard";

const TOOL = "/pkg/dist/simpb/serve-sim-pasteboard";

describe("sim clipboard commands", () => {
  test("the write quotes text so shell metacharacters stay literal", () => {
    const text = "it's 100% café";
    expect(pbcopyCommand("UDID-1", text, TOOL)).toBe(
      `printf '%s' 'it'\\''s 100% café' | xcrun simctl spawn 'UDID-1' '${TOOL}'`,
    );
  });

  test("the write runs inside the simulator, not through the host bridge", () => {
    const command = pbcopyCommand("UDID-1", "hi", TOOL);
    expect(command).toContain("simctl spawn");
    expect(command).not.toContain("pbcopy");
    expect(command).not.toContain("LANG=");
  });

  test("copyTextToSim inlines short text", async () => {
    const cmds: string[] = [];
    const ok = await copyTextToSim("UDID-1", "hello", async (cmd) => {
      cmds.push(cmd);
      return { stdout: "", stderr: "", exitCode: 0 };
    }, TOOL);
    expect(ok).toBe(true);
    expect(cmds).toEqual([pbcopyCommand("UDID-1", "hello", TOOL)]);
  });

  test("copyTextToSim stages a temp file above the inline limit", async () => {
    const cmds: string[] = [];
    const text = "x".repeat(PBCOPY_INLINE_MAX + 1);
    const ok = await copyTextToSim("UDID-1", text, async (cmd) => {
      cmds.push(cmd);
      return { stdout: "", stderr: "", exitCode: 0 };
    }, TOOL);
    expect(ok).toBe(true);
    expect(cmds.some((c) => c.includes("base64 -d"))).toBe(true);
    expect(cmds.some((c) => c.includes("simctl spawn") && c.includes(" < "))).toBe(true);
    expect(cmds.some((c) => c.startsWith("rm -f "))).toBe(true);
    expect(cmds.some((c) => c.includes("printf '%s'"))).toBe(false);
  });

  test("copyTextToSim returns false when the write exits non-zero", async () => {
    const ok = await copyTextToSim("UDID-1", "hello", async () => {
      return { stdout: "", stderr: "boom", exitCode: 1 };
    }, TOOL);
    expect(ok).toBe(false);
  });

  test("copyTextToSim uses UTF-8 byte length for the inline limit", async () => {
    const cmds: string[] = [];
    const text = "你".repeat(Math.floor(PBCOPY_INLINE_MAX / 3) + 1);
    expect(text.length).toBeLessThanOrEqual(PBCOPY_INLINE_MAX);
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(PBCOPY_INLINE_MAX);
    const ok = await copyTextToSim("UDID-1", text, async (cmd) => {
      cmds.push(cmd);
      return { stdout: "", stderr: "", exitCode: 0 };
    }, TOOL);
    expect(cmds.some((c) => c.includes("printf '%s'"))).toBe(false);
    expect(cmds.some((c) => c.includes("base64 -d"))).toBe(true);
    expect(ok).toBe(true);
  });
});

describe("sim paste HID", () => {
  const usage = (code: string): number => {
    const value = HID_USAGE_BY_CODE[code];
    if (value === undefined) throw new Error(`no HID usage for ${code}`);
    return value;
  };
  const ControlLeft = usage("ControlLeft");
  const ControlRight = usage("ControlRight");
  const MetaLeft = usage("MetaLeft");
  const MetaRight = usage("MetaRight");
  const KeyV = usage("KeyV");
  const held = (...usages: number[]): Set<number> => new Set(usages);

  test("taps Cmd+V when no modifiers are held", () => {
    expect(simPasteHidEvents(new Set())).toEqual([
      { type: "down", usage: MetaLeft },
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
      { type: "up", usage: MetaLeft },
    ]);
  });

  test("only taps V when Command is already down", () => {
    expect(simPasteHidEvents(held(MetaLeft))).toEqual([
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
    ]);
    expect(simPasteHidEvents(held(MetaRight))).toEqual([
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
    ]);
  });

  test("sends Cmd+C for the copy shortcut", () => {
    const KeyC = usage("KeyC");
    expect(simCopyHidEvents(held())).toEqual([
      { type: "down", usage: MetaLeft },
      { type: "down", usage: KeyC },
      { type: "up", usage: KeyC },
      { type: "up", usage: MetaLeft },
    ]);
  });

  test("sends Cmd+A for select all", () => {
    const KeyA = usage("KeyA");
    expect(simSelectAllHidEvents(held())).toEqual([
      { type: "down", usage: MetaLeft },
      { type: "down", usage: KeyA },
      { type: "up", usage: KeyA },
      { type: "up", usage: MetaLeft },
    ]);
  });

  test("releases Control before injecting Cmd+V", () => {
    expect(simPasteHidEvents(held(ControlLeft))).toEqual([
      { type: "up", usage: ControlLeft },
      { type: "down", usage: MetaLeft },
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
      { type: "up", usage: MetaLeft },
    ]);
    expect(simPasteHidEvents(held(ControlLeft, ControlRight, MetaLeft))).toEqual([
      { type: "up", usage: ControlLeft },
      { type: "up", usage: ControlRight },
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
    ]);
  });
});

describe("readSimClipboard", () => {
  function withStubs(
    response: Response,
    run: (requests: Array<{ input: string; init?: RequestInit }>) => Promise<void>,
  ): Promise<void> {
    const realFetch = globalThis.fetch;
    const realWindow = Reflect.get(globalThis, "window");
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    Object.defineProperty(globalThis, "window", {
      value: {
        __SIM_PREVIEW__: { basePath: "/", execToken: "test-token" },
        location: { pathname: "/" },
      },
      configurable: true,
      writable: true,
    });
    const stub: typeof fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input: String(input), init });
        return response;
      },
      { preconnect: realFetch.preconnect },
    );
    globalThis.fetch = stub;
    return run(requests).finally(() => {
      globalThis.fetch = realFetch;
      if (realWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else Object.defineProperty(globalThis, "window", { value: realWindow, configurable: true, writable: true });
    });
  }

  test("POSTs the selected device and returns the text the endpoint reports", async () => {
    await withStubs(Response.json({ ok: true, text: "café 🎉" }), async (requests) => {
      expect(await readSimClipboard("UDID-1")).toBe("café 🎉");
      expect(requests).toEqual([
        {
          input: "/api/pasteboard?device=UDID-1",
          init: {
            method: "POST",
            headers: { Authorization: "Bearer test-token" },
          },
        },
      ]);
    });
  });

  test("surfaces the endpoint's own error message", async () => {
    await withStubs(
      Response.json({ ok: false, error: "Timed out reading the simulator pasteboard" }, { status: 500 }),
      async () => {
        await expect(readSimClipboard("UDID-1")).rejects.toThrow(/Timed out/);
      },
    );
  });

  test("falls back to a status message when the body carries no error", async () => {
    await withStubs(Response.json({}, { status: 502 }), async () => {
      await expect(readSimClipboard("UDID-1")).rejects.toThrow(/502/);
    });
  });

});
