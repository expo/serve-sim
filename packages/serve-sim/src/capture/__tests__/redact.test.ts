import { describe, expect, test } from "bun:test";

import { isSensitiveHeaderName, redactHeaders } from "../redact";

describe("redactHeaders", () => {
  test("redacts sensitive header values case-insensitively", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
        cookie: "sid=1",
        "X-Api-Key": "k",
        "X-Auth-Token": "t",
        "Proxy-Authorization": "Basic x",
        "Set-Cookie": "a=b",
      }),
    ).toEqual({
      Authorization: "[REDACTED]",
      "Content-Type": "application/json",
      cookie: "[REDACTED]",
      "X-Api-Key": "[REDACTED]",
      "X-Auth-Token": "[REDACTED]",
      "Proxy-Authorization": "[REDACTED]",
      "Set-Cookie": "[REDACTED]",
    });
  });

  test("redacts vendor headers the list never enumerated", () => {
    // The denylist cannot keep up with these, and recording one is worse than over-redacting.
    expect(
      redactHeaders({
        "X-Goog-Api-Key": "k",
        "x-firebase-appcheck": "t",
        "x-amz-security-token": "s",
        "X-Acme-Session-Id": "sid",
        "x-refresh-token": "r",
        "x-signature": "sig",
        "private-key": "pk",
      }),
    ).toEqual({
      "X-Goog-Api-Key": "[REDACTED]",
      "x-firebase-appcheck": "[REDACTED]",
      "x-amz-security-token": "[REDACTED]",
      "X-Acme-Session-Id": "[REDACTED]",
      "x-refresh-token": "[REDACTED]",
      "x-signature": "[REDACTED]",
      "private-key": "[REDACTED]",
    });
  });

  test("keeps headers that only look sensitive at a glance", () => {
    // Over-redaction has a cost too: these are what make a captured request readable.
    expect(
      redactHeaders({
        "Content-Type": "application/json",
        "content-length": "12",
        accept: "*/*",
        "user-agent": "CoinFlip/1.0",
        "cache-control": "no-store",
        "x-request-id": "abc",
        host: "example.test",
      }),
    ).toEqual({
      "Content-Type": "application/json",
      "content-length": "12",
      accept: "*/*",
      "user-agent": "CoinFlip/1.0",
      "cache-control": "no-store",
      "x-request-id": "abc",
      host: "example.test",
    });
  });

  test("names the rule so the docs and the code cannot drift", () => {
    expect(isSensitiveHeaderName("Authorization")).toBe(true);
    expect(isSensitiveHeaderName("x-session-id")).toBe(true);
    expect(isSensitiveHeaderName("accept")).toBe(false);
  });

});
