import { isIP } from "node:net";
import { isPublicNetworkAddress, parseConnectAuthority } from "./public-network-target";

export interface BrowserRequestDetails { webContentsId?: number; url: string; method: string; resourceType: string }
const allowedResources = new Set(["mainFrame", "subFrame", "stylesheet", "script", "image", "font", "media", "xhr"]);

/** Caller must supply the identity from a Main registration, never renderer input.
 * DNS/actual egress is enforced separately by the authenticated CONNECT proxy.
 * https://github.com/electron/electron/blob/v43.1.0/docs/api/web-request.md
 */
export function createBrowserRequestPolicy(webContentsId: number, signal: AbortSignal): { allows(details: BrowserRequestDetails): boolean; revoke(): void } {
  if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) throw new Error("invalid browser identity");
  let revoked = false;
  return {
    revoke() { revoked = true; },
    allows(details) {
      if (revoked || signal.aborted || details.webContentsId !== webContentsId
        || (details.method !== "GET" && details.method !== "HEAD") || !allowedResources.has(details.resourceType)) return false;
      try {
        const url = new URL(details.url);
        if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
        const target = parseConnectAuthority(`${url.hostname}:443`);
        return !!target && (!isIP(target.host) || isPublicNetworkAddress(target.host));
      } catch { return false; }
    },
  };
}
