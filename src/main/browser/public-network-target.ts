import { BlockList, isIP } from "node:net";

// Conservative snapshot of IANA special-purpose space (2026-10-04).
// Includes globally reachable exceptions: false negatives are preferable here.
// https://www.iana.org/assignments/iana-ipv4-special-registry
// https://www.iana.org/assignments/iana-ipv6-special-registry
const special = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) special.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["2620:4f:8000::", 48]] as const) {
  special.addSubnet(address, prefix, "ipv6");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function isPublicNetworkAddress(address: string): boolean {
  if (address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) return !special.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !special.check(address, "ipv6");
}

/** CONNECT authority only; no URL normalization can erase hostile syntax. */
export function parseConnectAuthority(authority: string): { host: string; port: 443 } | null {
  if (authority.length > 260) return null;
  const match = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+):443$/.exec(authority);
  if (!match) return null;
  const raw = match[1];
  const host = raw.startsWith("[") ? raw.slice(1, -1).toLowerCase() : raw.toLowerCase();
  if (raw.startsWith("[")) return isIP(host) === 6 ? { host, port: 443 } : null;
  if (isIP(host) === 4) return { host, port: 443 };
  const labels = host.split(".");
  if (host.length > 253 || labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return { host, port: 443 };
}
