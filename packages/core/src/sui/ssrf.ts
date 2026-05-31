import { lookup as dnsLookup } from "node:dns/promises";

const PRIVATE_RANGES: Array<{ mask: number; bits: number }> = [
  { mask: 0x0a000000, bits: 8 },  // 10.0.0.0/8
  { mask: 0xac100000, bits: 12 }, // 172.16.0.0/12
  { mask: 0xc0a80000, bits: 16 }, // 192.168.0.0/16
  { mask: 0x7f000000, bits: 8 },  // 127.0.0.0/8
  { mask: 0xa9fe0000, bits: 16 }, // 169.254.0.0/16 link-local
  { mask: 0x64400000, bits: 10 }, // 100.64.0.0/10 shared
  { mask: 0x00000000, bits: 32 }, // 0.0.0.0/32
];

function ipv4ToInt(addr: string): number {
  const parts = addr.split(".").map(Number);
  if (parts.length !== 4) return -1;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function isPrivateIPv4(addr: string): boolean {
  const n = ipv4ToInt(addr);
  if (n < 0) return false;
  for (const { mask, bits } of PRIVATE_RANGES) {
    const prefixMask = bits === 32 ? 0xffffffff : ~(0xffffffff >>> bits);
    if ((n & prefixMask) >>> 0 === mask >>> 0) return true;
  }
  return false;
}

function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower === "::" || lower === "0:0:0:0:0:0:0:1") return true;
  return false;
}

export async function assertSafeUrl(input: string, opts: { allowLoopback?: boolean } = {}): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  const scheme = parsed.protocol;
  if (scheme !== "https:" && scheme !== "http:") {
    throw new Error(`URL scheme must be https or http, got: ${scheme}`);
  }
  if (scheme === "http:" && !opts.allowLoopback) {
    throw new Error(`Plain http is only allowed with allowLoopback=true (received: ${input})`);
  }

  const hostname = parsed.hostname;

  // block .local mDNS
  if (hostname.endsWith(".local")) {
    throw new Error(`SSRF guard: .local mDNS hostnames are not allowed (${hostname})`);
  }

  // allow loopback explicitly when opted in
  if (opts.allowLoopback && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1")) {
    return parsed;
  }

  // resolve and check all IPs
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsLookup(hostname, { all: true });
  } catch {
    throw new Error(`SSRF guard: could not resolve hostname: ${hostname}`);
  }

  for (const { address, family } of addresses) {
    if (family === 4 && isPrivateIPv4(address)) {
      throw new Error(`SSRF guard: resolved to private/loopback IPv4 ${address} for ${hostname}`);
    }
    if (family === 6 && isPrivateIPv6(address)) {
      throw new Error(`SSRF guard: resolved to private/loopback IPv6 ${address} for ${hostname}`);
    }
  }

  return parsed;
}
