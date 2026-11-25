import { PluginError, PLUGIN_TO_HOST_METHODS } from "../../../shared/plugin-protocol";
import type { PluginRpc } from "../../../shared/plugin-rpc";
import { createPluginNotificationLimiter, parsePluginNotification } from "../../../shared/plugin-notifications";

export interface NotificationAccess {
  name: string;
  declared: readonly string[];
  granted: ReadonlySet<string>;
  /** Advance on disable, revoke/regrant, upgrade or manifest replacement. */
  revision: number;
}
export interface NativePluginNotification {
  on(event: "show" | "failed" | "close" | "click", listener: () => void): unknown;
  removeListener(event: "show" | "failed" | "close" | "click", listener: () => void): unknown;
  show(): void;
  close(): void;
}
export interface PluginNotificationDependencies {
  /** Installed manifest name/declarations and live grants, never RPC-provided identity. Null when disabled. */
  access(pluginId: string): NotificationAccess | null;
  /** Must fire synchronously for disable, revoke/regrant and upgrade. */
  onAccessChange(pluginId: string, listener: () => void): () => void;
  isSupported(): boolean;
  /** Optional visibility preference. Do not bind a sound-only setting here. */
  isEnabled?(): boolean;
  create(options: { title: string; body: string }): NativePluginNotification;
  /** Restore/show/focus the main window only; never interpret notification text as a URL or command. */
  focusMainWindow(): void;
}
const permission = () => new PluginError("ERR_PERMISSION", "Notification permission is not granted");
const cancelled = () => new PluginError("ERR_CANCELLED", "Notification request cancelled");
const SHOW_TIMEOUT_MS = 5_000;

/** Compose alongside other v2 services in HostDependencies.configureRpc; dispose on host shutdown. */
export function createPluginNotifications(deps: PluginNotificationDependencies) {
  const consume = createPluginNotificationLimiter();
  const connections = new Set<() => void>();
  let disposed = false;
  function configureRpc(pluginId: string, rpc: PluginRpc): () => void {
    if (disposed) throw new PluginError("ERR_UNAVAILABLE", "Notification service is disposed");
    let closed = false;
    const active = new Set<{ check(): void; stop(error?: PluginError, closeNative?: boolean): void }>();
    const check = (revision?: number) => {
      const access = deps.access(pluginId);
      if (!access) throw permission();
      if (!access.declared.includes("notifications")) throw new PluginError("ERR_UNDECLARED", "Notification permission is not declared");
      if (!access.granted.has("notifications") || (revision !== undefined && access.revision !== revision)) throw permission();
      if (closed) throw cancelled();
      return access;
    };
    const unsubscribe = deps.onAccessChange(pluginId, () => {
      for (const operation of active) {
        try { operation.check(); } catch { operation.stop(permission()); }
      }
    });
    const unregister = rpc.handle(PLUGIN_TO_HOST_METHODS.notificationsShow, (input, { signal }) => {
      const access = check();
      const options = parsePluginNotification(input);
      if (signal.aborted) throw cancelled();
      consume(pluginId);
      try { if (deps.isEnabled?.() === false || !deps.isSupported()) return { shown: false }; } catch { return { shown: false }; }
      return new Promise<{ shown: boolean }>((resolve, reject) => {
        let notification: NativePluginNotification;
        try { notification = deps.create({ title: `〔${access.name.replace(/[\p{Cc}\p{Cf}]/gu, "")}〕${options.title}`, body: options.body }); }
        catch { resolve({ shown: false }); return; }
        let settled = false, stopped = false;
        let displayExpiry: ReturnType<typeof setTimeout> | undefined;
        const guard = () => { check(access.revision); if (signal.aborted && !settled) throw cancelled(); };
        const finish = (shown: boolean, error?: PluginError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          notification.removeListener("show", show);
          notification.removeListener("failed", failed);
          if (error) reject(error); else resolve({ shown });
        };
        const stop = (error?: PluginError, closeNative = true) => {
          if (stopped) return;
          stopped = true;
          finish(false, error);
          clearTimeout(displayExpiry);
          active.delete(operation);
          notification.removeListener("click", click);
          notification.removeListener("close", close);
          if (closeNative) {
            try { notification.close(); } catch { /* Platform teardown must not retain plugin listeners. */ }
          }
        };
        const show = () => {
          try { guard(); finish(true); } catch { stop(permission()); }
        };
        const failed = () => stop();
        const close = () => stop();
        const click = () => {
          try { guard(); deps.focusMainWindow(); } catch { /* Stale notifications cannot activate a disabled plugin. */ }
        };
        const abort = () => stop(cancelled());
        const operation = { check: guard, stop };
        // Electron cannot reliably observe OS-level suppression. No show event means unconfirmed delivery.
        const timer = setTimeout(() => stop(), SHOW_TIMEOUT_MS);
        active.add(operation);
        notification.on("show", show); notification.on("failed", failed);
        notification.on("close", close); notification.on("click", click);
        signal.addEventListener("abort", abort, { once: true });
        // Bound native references even on platforms that never emit close. Only release the listeners:
        // closing here would also remove a shown reminder from the Windows Action Center.
        displayExpiry = setTimeout(() => stop(undefined, false), 5 * 60_000);
        try { guard(); notification.show(); } catch (error) { stop(error instanceof PluginError ? error : undefined); }
      });
    });
    const disposeConnection = () => {
      if (closed) return;
      closed = true; unregister(); unsubscribe();
      for (const operation of active) operation.stop(cancelled());
      connections.delete(disposeConnection);
    };
    connections.add(disposeConnection);
    return disposeConnection;
  }
  return { configureRpc, dispose: () => { disposed = true; for (const dispose of connections) dispose(); } };
}
