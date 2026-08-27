import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MAX_CONTROL_BODY_BYTES,
  describeFailure,
  formatOversizedControlBodyWarning,
  locateMitmdump,
  maxControlBodyBytes,
  mitmdumpMissingMessage,
  parseMitmPids,
} from "../mitm-engine";

const MARKER = "serve-sim-capture-Qz7pLm";
const SELF = 400;

// mitmdump is an app-bundle launcher, so a session has more than one process and the one holding the
// port is not the one we spawned. Every process started with the session's confdir carries its name,
// which is what makes the confdir usable as an identifier.
const psFixture = [
  `  ${SELF} bun run serve-sim --udid ABC ${MARKER}`,
  `  7101 /x/mitmproxy.app/Contents/MacOS/mitmdump -q --listen-port 5555 --set confdir=/var/T/${MARKER}`,
  `  7102 /x/mitmproxy.app/Contents/Frameworks/Python --set confdir=/var/T/${MARKER} -s servesim_capture.py`,
  "  7103 /opt/homebrew/bin/mitmdump --set confdir=/Users/gabe/.mitmproxy",
  "  7104 /Applications/Safari.app/Contents/MacOS/Safari",
].join("\n");

describe("parseMitmPids", () => {
  test("finds every process started with this session's confdir", () => {
    expect(parseMitmPids(psFixture, MARKER, SELF)).toEqual([7101, 7102]);
  });

  test("leaves a mitmproxy the developer runs themselves alone", () => {
    // 7103 is on the default confdir; killing it would take down their own debugging session.
    expect(parseMitmPids(psFixture, MARKER, SELF)).not.toContain(7103);
  });

  test("never returns our own pid, even though the marker is in our command line", () => {
    expect(parseMitmPids(psFixture, MARKER, SELF)).not.toContain(SELF);
  });

  test("returns nothing when no process matches, so a second shutdown is harmless", () => {
    expect(parseMitmPids(psFixture, "serve-sim-capture-Nope00", SELF)).toEqual([]);
    expect(parseMitmPids("", MARKER, SELF)).toEqual([]);
  });

  test("ignores lines carrying the marker without a parsable pid", () => {
    const noisy = [`  not-a-pid ${MARKER}`, `  7200 mitmdump ${MARKER}`].join("\n");
    expect(parseMitmPids(noisy, MARKER, SELF)).toEqual([7200]);
  });
});

describe("locateMitmdump", () => {
  /** Runs a case with SERVE_SIM_MITMDUMP controlled, so a developer's own env can't change the result. */
  function withOverride<T>(value: string | undefined, body: () => T): T {
    const previous = process.env.SERVE_SIM_MITMDUMP;
    if (value === undefined) delete process.env.SERVE_SIM_MITMDUMP;
    else process.env.SERVE_SIM_MITMDUMP = value;
    try {
      return body();
    } finally {
      if (previous === undefined) delete process.env.SERVE_SIM_MITMDUMP;
      else process.env.SERVE_SIM_MITMDUMP = previous;
    }
  }

  test("prefers whatever is on PATH, which is where brew puts it", () => {
    withOverride(undefined, () => {
      expect(locateMitmdump({ which: () => "/opt/homebrew/bin/mitmdump" })).toBe(
        "/opt/homebrew/bin/mitmdump",
      );
    });
  });

  test("reports nothing when the developer has no mitmproxy at all", () => {
    withOverride(undefined, () => {
      // Candidates are injected: otherwise this passes or fails depending on whether the machine running
      // the suite happens to have mitmproxy installed.
      expect(locateMitmdump({ which: () => null, candidates: ["/nope/mitmdump"] })).toBeNull();
    });
  });

  test("rejects an override pointing at a path that does not exist", () => {
    withOverride("/nope/mitmdump", () => {
      // Honouring it blindly would produce a spawn error instead of a message the developer can act on.
      expect(locateMitmdump({ which: () => "/opt/homebrew/bin/mitmdump", candidates: [] })).toBeNull();
    });
  });

  test("honours an override that does exist, ahead of anything on PATH", () => {
    withOverride("/bin/sh", () => {
      expect(locateMitmdump({ which: () => "/opt/homebrew/bin/mitmdump" })).toBe("/bin/sh");
    });
  });
});

describe("mitmdumpMissingMessage", () => {
  test("says what is missing, why it isn't bundled, and the command that fixes it", () => {
    const message = mitmdumpMissingMessage();
    expect(message).toContain("brew install mitmproxy");
    expect(message).toContain("mitmproxy.org/downloads");
    // The escape hatch matters for anyone whose install is somewhere unusual.
    expect(message).toContain("SERVE_SIM_MITMDUMP");
  });
});

describe("maxControlBodyBytes", () => {
  function withEnv<T>(value: string | undefined, body: () => T): T {
    const key = "SERVE_SIM_CAPTURE_MAX_CONTROL_BODY_BYTES";
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
      return body();
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }

  test("defaults to 10 MiB", () => {
    withEnv(undefined, () => {
      expect(maxControlBodyBytes()).toBe(DEFAULT_MAX_CONTROL_BODY_BYTES);
      expect(DEFAULT_MAX_CONTROL_BODY_BYTES).toBe(10 * 1024 * 1024);
    });
  });

  test("honours a positive integer override", () => {
    withEnv("1048576", () => {
      expect(maxControlBodyBytes()).toBe(1_048_576);
    });
  });

  test("ignores blank or non-positive values", () => {
    withEnv(" ", () => expect(maxControlBodyBytes()).toBe(DEFAULT_MAX_CONTROL_BODY_BYTES));
    withEnv("0", () => expect(maxControlBodyBytes()).toBe(DEFAULT_MAX_CONTROL_BODY_BYTES));
    withEnv("-1", () => expect(maxControlBodyBytes()).toBe(DEFAULT_MAX_CONTROL_BODY_BYTES));
    withEnv("nope", () => expect(maxControlBodyBytes()).toBe(DEFAULT_MAX_CONTROL_BODY_BYTES));
  });
});

describe("formatOversizedControlBodyWarning", () => {
  test("names the path, sizes, and env override so a greppable terminal line diagnoses repeats", () => {
    const message = formatOversizedControlBodyWarning({
      bytesSeen: 11_000_000,
      limit: 10_485_760,
      path: "/response",
    });
    expect(message).toContain("[capture] Dropped oversized control body");
    expect(message).toContain("/response");
    expect(message).toContain("11000000");
    expect(message).toContain("SERVE_SIM_CAPTURE_MAX_CONTROL_BODY_BYTES");
  });
});

describe("describeFailure", () => {
  /**
   * The proxy reports socket-level errno strings. They are accurate and nearly useless on their own —
   * a developer seeing "[Errno 61]" in a request list should not have to know what 61 means.
   */
  test("explains a refused connection", () => {
    const out = describeFailure("[Errno 61] Connect call failed ('127.0.0.1', 9)");
    expect(out).toContain("Nothing was listening");
    // The raw text is kept, so the detail is not lost.
    expect(out).toContain("Errno 61");
  });

  test("explains an unresolvable host", () => {
    expect(describeFailure("[Errno 8] nodename nor servname provided, or not known")).toContain(
      "could not be resolved",
    );
  });

  test("names certificate pinning, which is the one a developer will hit and misread", () => {
    expect(describeFailure("Client TLS handshake failed: certificate verify failed")).toContain("pin");
  });

  test("passes an unrecognised reason through rather than inventing one", () => {
    expect(describeFailure("something entirely new")).toBe("something entirely new");
  });
});

