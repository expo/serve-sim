import { networkInterfaces } from "os";

export type IcePin = {
  ipv6Prefix?: string;
};

type IceCandidate = {
  line: string;
  address: string;
  type: string;
  protocol: string;
  priority: number;
};

function newlineFor(sdp: string): "\r\n" | "\n" {
  return sdp.includes("\r\n") ? "\r\n" : "\n";
}

function parseCandidate(line: string): IceCandidate | undefined {
  const body = line.startsWith("a=") ? line.slice(2) : line;
  if (!body.startsWith("candidate:")) return undefined;
  const parts = body.split(/\s+/);
  const protocol = (parts[2] ?? "").toLowerCase();
  const priority = Number(parts[3]);
  const address = parts[4];
  const typeIndex = parts.indexOf("typ");
  const type = typeIndex >= 0 ? parts[typeIndex + 1] : "";
  if (!address || !type || !protocol) return undefined;
  return {
    line,
    address,
    type,
    protocol,
    priority: Number.isFinite(priority) ? priority : 0,
  };
}

function isLoopbackAddress(address: string): boolean {
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
  if (address.startsWith("::ffff:")) {
    return isLoopbackAddress(address.slice("::ffff:".length));
  }
  return address === "127.0.0.1" || address.startsWith("127.");
}

function isIPv6Address(address: string): boolean {
  return address.includes(":");
}

function isMdnsAddress(address: string): boolean {
  return /\.local\.?$/i.test(address);
}

function splitHextets(address: string): string[] | undefined {
  const ip = address.toLowerCase().split("%")[0];
  if (!ip || !ip.includes(":")) return undefined;
  const [head, tail] = ip.split("::");
  const left = head ? head.split(":").filter(Boolean) : [];
  const right = tail ? tail.split(":").filter(Boolean) : [];
  if (ip.includes("::")) {
    const missing = 8 - left.length - right.length;
    if (missing < 0) return undefined;
    return [...left, ...Array(missing).fill("0"), ...right];
  }
  return left.length === 8 ? left : undefined;
}

export function ipv6Prefix64(address: string): string | undefined {
  const parts = splitHextets(address);
  if (!parts) return undefined;
  return parts.slice(0, 4).map((part) => part.replace(/^0+/, "") || "0").join(":");
}

function tartHostV4(): string {
  const guest = process.env.TART_IP;
  if (guest && /^\d+\.\d+\.\d+\.\d+$/.test(guest)) {
    const octets = guest.split(".");
    octets[3] = "1";
    return octets.join(".");
  }
  return process.env.TART_HOST_IP ?? "192.168.64.1";
}

export function detectTartBridgeIPv6Prefix(hostV4 = tartHostV4()): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    if (!addrs?.some((addr) => String(addr.family).startsWith("IPv4") && addr.address === hostV4)) {
      continue;
    }
    for (const addr of addrs) {
      if (!String(addr.family).startsWith("IPv6")) continue;
      if (addr.address.startsWith("fe80:")) continue;
      const prefix = ipv6Prefix64(addr.address);
      if (prefix) return prefix;
    }
  }
  return undefined;
}

/**
 * WebRTC still requires ICE, even on Tart's LAN. Chrome on localhost gathers
 * loopback, mDNS-hidden IPv4 vmnet (higher priority than IPv6), and Google
 * srflx. ICE then nominates 192.168.64.4 -> 192.168.64.1, which never carries
 * RTP. Keep one UDP host path: Tart bridge IPv6 when we have it.
 */
export function stabilizeDirectIceSdp(sdp: string, pin: IcePin = {}): string {
  const newline = newlineFor(sdp);
  const lines = sdp.split(newline);
  const udpHosts = lines.flatMap((line) => {
    const candidate = parseCandidate(line);
    if (!candidate || candidate.type !== "host" || candidate.protocol !== "udp") return [];
    if (isLoopbackAddress(candidate.address)) return [];
    return [candidate];
  });
  const ipv6Hosts = udpHosts.filter((candidate) => isIPv6Address(candidate.address));
  const mdnsHosts = udpHosts.filter((candidate) => isMdnsAddress(candidate.address));
  const ipv4Hosts = udpHosts.filter((candidate) => (
    !isIPv6Address(candidate.address) && !isMdnsAddress(candidate.address)
  ));

  let keep = udpHosts;
  if (ipv6Hosts.length) {
    const pinned = pin.ipv6Prefix
      ? ipv6Hosts.filter((candidate) => ipv6Prefix64(candidate.address) === pin.ipv6Prefix)
      : [];
    keep = pinned.length ? pinned : ipv6Hosts;
  } else if (mdnsHosts.length) {
    const priorities = [...new Set(mdnsHosts.map((candidate) => candidate.priority))];
    if (priorities.length > 1) {
      const ipv6Priority = Math.min(...priorities);
      keep = mdnsHosts.filter((candidate) => candidate.priority === ipv6Priority);
    } else {
      keep = mdnsHosts;
    }
  } else {
    keep = ipv4Hosts;
  }

  if (!keep.length) return sdp;
  const keepLines = new Set(keep.map((candidate) => candidate.line));

  return lines.filter((line) => {
    const candidate = parseCandidate(line);
    if (!candidate) return true;
    return keepLines.has(line);
  }).join(newline);
}

export function rewriteWebRtcSignalingJson(body: string, pin: IcePin = {}): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body;
  const record = parsed as { type?: unknown; sdp?: unknown };
  if (typeof record.sdp !== "string") return body;
  const rewritten = {
    ...record,
    sdp: stabilizeDirectIceSdp(record.sdp, pin),
    ...(record.type === "offer" ? { iceServers: [] } : {}),
  };
  return JSON.stringify(rewritten);
}
