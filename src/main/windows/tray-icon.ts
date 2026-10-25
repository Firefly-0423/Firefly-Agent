import path from "node:path";
import { app, nativeImage } from "electron";

export function loadTrayIcon() {
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), "assets", "icons", "tray.ico"));
  if (!icon.isEmpty()) return icon;
  return nativeImage.createFromPath(path.join(app.getAppPath(), "assets", "icons", "firefly.png"));
}
