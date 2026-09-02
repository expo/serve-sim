import { describe, expect, test } from "bun:test";
import {
  ipv6Prefix64,
  rewriteWebRtcSignalingJson,
  stabilizeDirectIceSdp,
} from "../ice-candidates";

const offer = [
  "v=0",
  "a=candidate:1 1 udp 2122260223 127.0.0.1 9 typ host",
  "a=candidate:2 1 udp 2122260223 192.168.64.1 65173 typ host",
  "a=candidate:3 1 udp 2122185727 fd2a:8aff:c3fa:95c6:10bb:f4f2:e22d:e2a5 61570 typ host",
  "a=candidate:4 1 udp 1686052607 203.0.113.8 3478 typ srflx raddr 192.168.64.1 rport 65173",
  "a=candidate:5 1 tcp 1518280447 192.168.64.1 9 typ host tcptype active",
  "",
].join("\r\n");

describe("ipv6Prefix64", () => {
  test("takes the first 64 bits", () => {
    expect(ipv6Prefix64("fd2a:8aff:c3fa:95c6:10bb:f4f2:e22d:e2a5")).toBe("fd2a:8aff:c3fa:95c6");
    expect(ipv6Prefix64("fd2a:8aff:c3fa:95c6::e2a5")).toBe("fd2a:8aff:c3fa:95c6");
  });
});

describe("stabilizeDirectIceSdp", () => {
  test("keeps tart IPv6 host and drops loopback, IPv4, srflx, and tcp", () => {
    const filtered = stabilizeDirectIceSdp(offer);
    expect(filtered).not.toContain("127.0.0.1");
    expect(filtered).not.toContain("192.168.64.1");
    expect(filtered).not.toContain("typ srflx");
    expect(filtered).toContain("fd2a:8aff:c3fa:95c6:10bb:f4f2:e22d:e2a5");
  });

  test("pins to the tart bridge prefix when several IPv6 hosts exist", () => {
    const sdp = [
      "a=candidate:1 1 udp 2122185727 fe80::1 9 typ host",
      "a=candidate:2 1 udp 2122185727 fd2a:8aff:c3fa:95c6:1886:4694:f409:5c0f 9 typ host",
    ].join("\r\n");
    const filtered = stabilizeDirectIceSdp(sdp, { ipv6Prefix: "fd2a:8aff:c3fa:95c6" });
    expect(filtered).not.toContain("fe80::1");
    expect(filtered).toContain("fd2a:8aff:c3fa:95c6:1886:4694:f409:5c0f");
  });

  test("drops higher-priority mDNS IPv4 host when an IPv6 mDNS host exists", () => {
    const sdp = [
      "a=candidate:1 1 udp 2122260223 1a2b3c4d-1.local 54812 typ host",
      "a=candidate:2 1 udp 2122185727 5e6f7a8b-2.local 61570 typ host",
      "a=candidate:3 1 udp 1686052607 203.0.113.8 3478 typ srflx",
    ].join("\r\n");
    const filtered = stabilizeDirectIceSdp(sdp);
    expect(filtered).not.toContain("1a2b3c4d-1.local");
    expect(filtered).not.toContain("typ srflx");
    expect(filtered).toContain("5e6f7a8b-2.local");
  });

  test("keeps IPv4 host when it is the only non-loopback path", () => {
    const sdp = [
      "a=candidate:1 1 udp 1 127.0.0.1 9 typ host",
      "a=candidate:2 1 udp 1 192.168.64.4 62849 typ host",
    ].join("\n");
    const filtered = stabilizeDirectIceSdp(sdp);
    expect(filtered).not.toContain("127.0.0.1");
    expect(filtered).toContain("192.168.64.4");
  });

  test("keeps loopback when nothing else is gathered", () => {
    const sdp = "a=candidate:1 1 udp 1 127.0.0.1 9 typ host\n";
    expect(stabilizeDirectIceSdp(sdp)).toContain("127.0.0.1");
  });
});

describe("rewriteWebRtcSignalingJson", () => {
  test("rewrites sdp and clears STUN on the offer", () => {
    const body = rewriteWebRtcSignalingJson(JSON.stringify({
      type: "offer",
      sessionId: "11111111-1111-4111-8111-111111111111",
      sdp: offer,
      iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
    }));
    const parsed = JSON.parse(body) as { sessionId: string; sdp: string; iceServers: unknown[] };
    expect(parsed.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.iceServers).toEqual([]);
    expect(parsed.sdp).not.toContain("127.0.0.1");
    expect(parsed.sdp).not.toContain("typ srflx");
    expect(parsed.sdp).toContain("fd2a:");
  });

  test("passes through non-JSON and bodies without sdp", () => {
    expect(rewriteWebRtcSignalingJson("not json")).toBe("not json");
    expect(rewriteWebRtcSignalingJson(JSON.stringify({ error: "busy" }))).toBe(
      JSON.stringify({ error: "busy" }),
    );
  });
});
