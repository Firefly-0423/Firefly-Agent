import type { IpcScope } from "../application/ipc-scope";
import type { ShutdownCoordinator } from "../application/shutdown";
import type { createBrowserService } from "./browser-service";
import { registerBrowserAvailabilityIpc, getOfflineBrowserAvailability } from "./browser-availability-ipc";
import type { App, WebContents } from "electron";
import { MANUAL_BROWSER_WORKSPACE_IPC } from "../../shared/manual-browser";
import type { createManualBrowserWorkspace } from "./manual-browser-workspace";
import { IPC } from "../../shared/ipc-channels";
import { rejectBrowserCertificate } from "./browser-certificate-policy";
type Service<S extends object> = ReturnType<typeof createBrowserService<S>>;
/** Main proposal for the shared contract owner; renderer cannot set a gate. */
export const BROWSER_SERVICE_CHANNELS = Object.freeze({ command: IPC.BROWSER_COMMAND, changed: IPC.BROWSER_CHANGED });
export function registerBrowserServiceIpc<S extends object>(scope: Pick<IpcScope, "handle">, service: Service<S>): void {
  registerBrowserAvailabilityIpc(scope, () => service.isEnabled() ? { available: true } : getOfflineBrowserAvailability());
  scope.handle(IPC.BROWSER_PERMISSION, async (event, command) => {
    try { return await service.dispatchPermission(event, command); } catch { return { ok: false, code: "permission_denied" }; }
  });
  scope.handle(IPC.BROWSER_COMMAND, async (event, command) => {
    try { return await service.dispatch(event, command); } catch { return { ok: false, code: "permission_denied" }; }
  });
}
/** Separate channels keep window browsing outside the conversation/Agent bridge.
 * The manager validates native sender/frame before accepting tab commands. */
export function registerManualBrowserWorkspaceIpc(scope: Pick<IpcScope, "handle">, service: ReturnType<typeof createManualBrowserWorkspace>): void {
  scope.handle(MANUAL_BROWSER_WORKSPACE_IPC.availability, () => service.isEnabled() ? { available: true } : getOfflineBrowserAvailability());
  scope.handle(MANUAL_BROWSER_WORKSPACE_IPC.permission, async (event, command) => {
    try { return await service.dispatchPermission(event, command); } catch { return { ok: false, code: "permission_denied" }; }
  });
  scope.handle(MANUAL_BROWSER_WORKSPACE_IPC.command, async (event, command) => {
    try { return await service.dispatchWorkspace(event, command); } catch { return { ok: false, code: "permission_denied" }; }
  });
}
/** Registered guest identities only; unrelated app authentication is unchanged.
 * https://github.com/electron/electron/blob/v43.1.0/docs/api/app.md#event-login
 */
export function installBrowserServiceLifecycle<S extends object>(app: Pick<App, "on" | "removeListener">, service: Service<S>, shutdown: Pick<ShutdownCoordinator, "register">, serviceId: "browser-service" | "manual-browser-service" = "browser-service"): () => void {
  const owns = (contents: WebContents) => service.isRegisteredBrowser(contents);
  const onLogin = (event: Electron.Event, contents: WebContents, _details: Electron.AuthenticationResponseDetails, auth: Electron.AuthInfo, callback: (username?: string, password?: string) => void) => {
    if (!owns(contents)) return;
    event.preventDefault();
    const credentials = service.credentialsFor(contents, auth);
    if (credentials) callback(credentials.username, credentials.password); else callback();
  };
  const onCertificate = (event: Electron.Event, contents: WebContents, _url: string, _error: string, _certificate: Electron.Certificate, callback: (trusted: boolean) => void) => {
    if (!owns(contents)) return; rejectBrowserCertificate(event, callback);
  };
  const onClientCertificate = (event: Electron.Event, contents: WebContents, _url: string, _certificates: Electron.Certificate[], callback: (certificate?: Electron.Certificate) => void) => {
    if (!owns(contents)) return; event.preventDefault(); callback();
  };
  app.on("login", onLogin); app.on("certificate-error", onCertificate); app.on("select-client-certificate", onClientCertificate);
  const offQuiesce = shutdown.register({ id: `${serviceId}-quiesce`, phase: "quiesce", dispose: () => service.revokeAll() });
  const offDispose = shutdown.register({ id: `${serviceId}-dispose`, phase: "stopExternalConsumers", dispose: async signal => {
    const result = await service.dispose(signal); if (!result.ok) throw new Error("browser cleanup failed");
  } });
  return () => { app.removeListener("login", onLogin); app.removeListener("certificate-error", onCertificate); app.removeListener("select-client-certificate", onClientCertificate); offQuiesce(); offDispose(); };
}
