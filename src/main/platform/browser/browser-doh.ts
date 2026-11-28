import { isIP } from "node:net";

/** AliDNS JSON API, reached by name: works behind a TUN proxy, and TLS checks the name. */
const ENDPOINT = "https://dns.alidns.com/resolve";
const RECORD_FAMILY = new Map([[1, 4], [28, 6]]);

/**
 * Resolve a host over DNS-over-HTTPS, for when the system resolver only returns a proxy's fake-ip addresses (Mihomo,
 * Clash or Surge TUN in fake-ip mode put every name in 198.18.0.0/15). Only the A and AAAA answers are returned; the
 * caller still checks every address is public and pins the one it dials. The host name is sent to AliDNS.
 */
export async function resolveOverHttps(host: string, signal: AbortSignal): Promise<{ address: string; family: number }[]> {
  const answers: { address: string; family: number }[] = [];
  for (const type of [1, 28]) {
    const response = await fetch(`${ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`, { signal, headers: { accept: "application/dns-json" } });
    if (!response.ok) throw Object.assign(new Error("DoH lookup failed"), { code: "EDOH" });
    const body = await response.json() as { Status?: unknown; Answer?: unknown };
    if (body.Status !== 0 && body.Status !== 3) throw Object.assign(new Error("DoH lookup failed"), { code: "EDOH" });
    for (const record of Array.isArray(body.Answer) ? body.Answer.slice(0, 64) : []) {
      const family = RECORD_FAMILY.get((record as { type?: unknown }).type as number), address = (record as { data?: unknown }).data;
      if (family && typeof address === "string" && isIP(address) === family) answers.push({ address, family });
    }
  }
  return answers;
}
