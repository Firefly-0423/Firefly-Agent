import { app, BrowserWindow, screen } from "electron";
import * as path from "path";
import { isDev } from "../env";
import { setToastWindow, toastWindow } from "./window-state";
import { TOAST_WINDOW_WIDTH } from "../toast/types";

/**
 * 取得 toast 提醒窗口：已存在则复用，否则新建。
 * 窗口常驻、初始隐藏、以 showInactive 方式出现，不抢焦点、不进任务栏。
 */
export function createToastWindowShell(): BrowserWindow {
  if (toastWindow && !toastWindow.isDestroyed()) return toastWindow;

  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  const webPreferences = {
    sandbox: false,
    nodeIntegration: false,
    contextIsolation: true,
    preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
  };
  const win = new BrowserWindow({
    width: TOAST_WINDOW_WIDTH,
    height: 1,
    x: x + width - TOAST_WINDOW_WIDTH,
    y: y + height,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    frame: false,
    backgroundColor: "#00000000",
    show: false,
    title: "Firefly · 提醒",
    webPreferences,
  });

  // 与桌宠使用同一层级（screen-saver），保证覆盖在全屏应用之上
  win.setAlwaysOnTop(true, "screen-saver");

  if (isDev) {
    void win.loadURL("http://localhost:5173/toast/");
  } else {
    void win.loadFile(path.join(app.getAppPath(), "dist", "renderer", "toast", "index.html"));
  }

  setToastWindow(win);
  win.on("closed", () => setToastWindow(null));
  return win;
}
