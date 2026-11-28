import { isIP } from "node:net";
import type { TrustedBrowserResolverConfig } from "./trusted-browser-resolver";
import { createElectronBrowserService } from "./electron-browser-service";
type Environment = Readonly<Record<string, string | undefined>>;
type StartupOptions = Pick<Parameters<typeof createElectronBrowserService>[0], "profile" | "onChanged" | "acceptDownload">;
/** Main launch input only; absence preserves OS DNS, never an all-user router default.
 * The private proxy factory also validates numeric unicast infrastructure endpoints.
 */
export function readBrowserStartupResolver(env: Environment): TrustedBrowserResolverConfig | undefined {
  const server = env.FIREFLY_BROWSER_DNS_SERVER, rawPort = env.FIREFLY_BROWSER_DNS_PORT;
  if (server === undefined && rawPort === undefined) return undefined;
  const port = rawPort === undefined ? 53 : /^[1-9]\d{0,4}$/.test(rawPort) ? Number(rawPort) : NaN;
  if (typeof server !== "string" || !isIP(server) || !Number.isSafeInteger(port) || port > 65535) {
    throw new Error("browser DNS configuration unavailable");
  }
  return Object.freeze({ server, port });
}
/** Startup can select DNS but cannot open the production browsing gate. */
export function createStartupBrowserService(options: StartupOptions, env: Environment = process.env) {
  return createElectronBrowserService({ profile: options.profile, onChanged: options.onChanged, acceptDownload: options.acceptDownload,
    trustedResolver: readBrowserStartupResolver(env),
  });
}
