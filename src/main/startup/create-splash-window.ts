import { app, BrowserWindow, screen } from "electron";
import path from "node:path";

export type CreateSplashWindowContext = {
  now?: () => number;
  onShown?(at: number): void;
  isDev: boolean;
};

function showSplash(splash: BrowserWindow, environment: CreateSplashWindowContext): void {
  if (splash.isDestroyed()) return;
  splash.show();
  splash.focus();
  try {
    environment.onShown?.((environment.now ?? (() => performance.now()))());
  } catch (failure) {
    console.error("[Splash] onShown callback failed:", failure);
  }
}

export function createSplashWindow(environment: CreateSplashWindowContext): BrowserWindow | null {
  try {
    const displaySize = screen.getPrimaryDisplay().workAreaSize;
    const side = 520;
    const splash = new BrowserWindow({
      width: side, height: side,
      x: Math.round((displaySize.width - side) / 2), y: Math.round((displaySize.height - side) / 2),
      transparent: true, frame: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, alwaysOnTop: true, skipTaskbar: true,
      hasShadow: false, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    splash.setIgnoreMouseEvents(true);
    if (environment.isDev) {
      splash.loadURL("http://localhost:5173/splash.html").catch((failure) => {
        console.error("[Splash] Failed to load dev URL:", failure);
      });
    } else {
      splash.loadFile(path.join(app.getAppPath(), "dist", "renderer", "splash.html")).catch((failure) => {
        console.error("[Splash] Failed to load splash.html:", failure);
      });
    }
    splash.once("ready-to-show", () => showSplash(splash, environment));
    return splash;
  } catch (failure) {
    console.error("[Splash] Failed to create splash window:", failure);
    return null;
  }
}
