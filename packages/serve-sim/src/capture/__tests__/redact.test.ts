import { describe, expect, test } from "bun:test";

import { isSensitiveHeaderName, redactHeaders } from "../redact";

describe("redactHeaders", () => {
  test("redacts sensitive header values case-insensitively", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
        cookie: "sid=1",
        Cookie2: "legacy",
        "X-Api-Key": "k",
        "Api-Key": "k2",
        apikey: "k3",
        "X-Api-Token": "tok",
        "X-Auth-Token": "t",
        "X-Access-Token": "a",
        "X-Refresh-Token": "r",
        "X-Session-Token": "s",
        "X-CSRF-Token": "c",
        "X-XSRF-Token": "x",
        "X-Amz-Security-Token": "aws",
        "X-Amz-Credential": "cred",
        Authentication: "custom",
        "Proxy-Authorization": "Basic x",
        "Set-Cookie": "a=b",
        "Set-Cookie2": "c=d",
      }),
    ).toEqual({
      Authorization: "[REDACTED]",
      "Content-Type": "application/json",
      cookie: "[REDACTED]",
      Cookie2: "[REDACTED]",
      "X-Api-Key": "[REDACTED]",
      "Api-Key": "[REDACTED]",
      apikey: "[REDACTED]",
      "X-Api-Token": "[REDACTED]",
      "X-Auth-Token": "[REDACTED]",
      "X-Access-Token": "[REDACTED]",
      "X-Refresh-Token": "[REDACTED]",
      "X-Session-Token": "[REDACTED]",
      "X-CSRF-Token": "[REDACTED]",
      "X-XSRF-Token": "[REDACTED]",
      "X-Amz-Security-Token": "[REDACTED]",
      "X-Amz-Credential": "[REDACTED]",
      Authentication: "[REDACTED]",
      "Proxy-Authorization": "[REDACTED]",
      "Set-Cookie": "[REDACTED]",
      "Set-Cookie2": "[REDACTED]",
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

  test("still redacts the names dropped from the explicit list", () => {
    // These were enumerated once. The pattern covers them now, and this is what makes removing them safe.
    for (const name of [
      "x-access-token",
      "x-refresh-token",
      "x-session-token",
      "x-csrf-token",
      "x-xsrf-token",
      "x-amz-security-token",
      "x-amz-credential",
      "api-key",
      "apikey",
      "x-api-token",
    ]) {
      expect(isSensitiveHeaderName(name)).toBe(true);
    }
  });

  test("redacts the names no pattern would catch", () => {
    // `authorization` has no word boundary after `auth`; `cookie2` none after `cookie`. Kept by name.
    for (const name of [
      "authorization",
      "proxy-authorization",
      "authentication",
      "cookie2",
      "set-cookie2",
      "x-firebase-appcheck",
    ]) {
      expect(isSensitiveHeaderName(name)).toBe(true);
    }
  });

  test("names the rule so the docs and the code cannot drift", () => {
    expect(isSensitiveHeaderName("Authorization")).toBe(true);
    expect(isSensitiveHeaderName("x-session-id")).toBe(true);
    expect(isSensitiveHeaderName("accept")).toBe(false);
  });

});
