import { Notification } from "electron";
import { createPluginNotifications, type PluginNotificationDependencies } from "./index";

/** Call after app.whenReady(); access and window activation are supplied by the v2 composition root. */
export function createElectronPluginNotifications(deps: Pick<PluginNotificationDependencies, "access" | "onAccessChange" | "focusMainWindow" | "isEnabled">) {
  return createPluginNotifications({
    ...deps,
    isSupported: () => Notification.isSupported(),
    create: options => new Notification(options),
  });
}
