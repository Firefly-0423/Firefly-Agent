import type { IpcScope } from "../application/ipc-scope";
import { IPC } from "../../shared/ipc-channels";
import type { BrowserAvailability } from "../../shared/browser-availability";
const unavailable: BrowserAvailability = Object.freeze({ available: false, reason: "network_unavailable" });
/** No guest/navigation API exists while the production network gate is closed. */
export function getOfflineBrowserAvailability(): BrowserAvailability { return unavailable; }
export function registerBrowserAvailabilityIpc(ipc: Pick<IpcScope, "handle">, availability: () => BrowserAvailability | { available: true } = getOfflineBrowserAvailability): void {
  ipc.handle(IPC.BROWSER_AVAILABILITY, availability);
}
