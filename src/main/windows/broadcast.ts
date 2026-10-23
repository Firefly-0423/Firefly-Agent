import { BrowserWindow } from "electron";

/** 把一条消息投递给仍然存活的全部窗口；窗口或其 webContents 已销毁的直接略过。 */
export function broadcastToAllWindows(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    const gone = win.isDestroyed() || win.webContents.isDestroyed();
    if (!gone) win.webContents.send(channel, payload);
  });
}
