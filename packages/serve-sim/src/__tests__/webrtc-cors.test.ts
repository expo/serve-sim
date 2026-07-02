import { describe, expect, test } from "bun:test";
import { CORS } from "../device-session";

describe("WebRTC CORS preflight", () => {
  test("allows JSON offer preflight requests", () => {
    expect(CORS["Access-Control-Allow-Origin"]).toBe("*");
    expect(CORS["Access-Control-Allow-Methods"]).toContain("OPTIONS");
    expect(CORS["Access-Control-Allow-Headers"]).toContain("Content-Type");
  });
});
