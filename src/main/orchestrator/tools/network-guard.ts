import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent } from "undici";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked.addSubnet(address, prefix, "ipv4");
// Azure platform virtual IP, also used for metadata/platform services.
blocked.addAddress("168.63.129.16", "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6"); // special-purpose and transition addresses
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6"); // 6to4 can embed a private IPv4 destination
blocked.addSubnet("3fff::", 20, "ipv6");

function assertPublicAddress(address: string): void {
  const family = isIP(address);
  if (!family || (family === 4 ? blocked.check(address, "ipv4")
    : !globalV6.check(address, "ipv6") || blocked.check(address, "ipv6"))) {
    throw new Error("Blocked non-public network address: " + address);
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** GET only. Each hop resolves once, validates every answer, then pins the connector
 * to those answers while retaining the URL hostname for Host and TLS verification.
 * Source: https://github.com/nodejs/undici/blob/v7.30.1/docs/docs/api/Connector.md
 */
export async function withPublicResponse<T>(
  input: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  let url = new URL(input);
  for (let hop = 0; ; hop++) {
    init.signal.throwIfAborted();
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
      throw new Error("Only HTTP(S) URLs without credentials are allowed");
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    // DNS cancellation is handled separately because dns.lookup has no signal option.
    const addresses = await new Promise<Awaited<ReturnType<typeof resolveAddresses>>>((resolve, reject) => {
      const abort = () => reject(init.signal.reason);
      init.signal.addEventListener("abort", abort, { once: true });
      resolveAddresses(hostname).then(resolve, reject).finally(() => init.signal.removeEventListener("abort", abort));
    });
    init.signal.throwIfAborted();
    if (!addresses.length) throw new Error("DNS returned no addresses");
    addresses.forEach(({ address }) => assertPublicAddress(address));
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, options, callback) => {
          // Both normal and auto-family lookup must return only the checked snapshot.
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        },
      },
    });
    let response: Response | undefined;
    try {
      // Node's bundled undici-types and the installed Undici have distinct type
      // identities; both implement the documented dispatcher protocol.
      const options: RequestInit = { ...init, redirect: "manual", dispatcher: dispatcher as unknown as RequestInit["dispatcher"] };
      response = await fetch(url.href, options);
      const location = response.headers.get("location");
      if (REDIRECT_STATUSES.has(response.status) && location) {
        if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects (maximum 5)");
        url = new URL(location, url);
        continue;
      }
      return await consume(response);
    } finally {
      try {
        if (response?.body && !response.body.locked) await response.body.cancel();
      } finally {
        await dispatcher.destroy();
      }
    }
  }
}

async function resolveAddresses(hostname: string) {
  const family = isIP(hostname);
  return family ? [{ address: hostname, family }] : lookup(hostname, { all: true });
}

/** Budget applies to the decoded fetch body (including compressed responses).
 * Keep at most maxBytes, probe one byte past the limit, then cancel immediately.
 */
export async function readResponseBytes(
  response: Response, maxBytes: number, truncate = false, onChunk?: () => void,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!response.body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let page: Buffer | undefined;
  let pageUsed = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { bytes: Buffer.concat(chunks, total), truncated: false };
      onChunk?.();
      const keep = Math.min(value.byteLength, maxBytes - total);
      // Coalesce tiny chunks so per-Buffer overhead cannot overwhelm the byte budget.
      let offset = 0;
      while (offset < keep) {
        if (!page || pageUsed === page.length) {
          page = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total));
          pageUsed = 0;
          chunks.push(page);
        }
        const count = Math.min(keep - offset, page.length - pageUsed);
        page.set(value.subarray(offset, offset + count), pageUsed);
        offset += count;
        pageUsed += count;
        total += count;
      }
      if (keep < value.byteLength) {
        if (!truncate) throw new Error(`文件过大：超过上限 ${maxBytes} 字节，已中止`);
        return { bytes: Buffer.concat(chunks, total), truncated: true };
      }
    }
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}
