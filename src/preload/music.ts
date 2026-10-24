import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc-channels";
import type { QqMusicAction } from "../main/music/qqmusic-service";

export function exposeMusicApi(): void {
  contextBridge.exposeInMainWorld("music", {
    getStatus: () => ipcRenderer.invoke(IPC.MUSIC_QQ_GET_STATUS),
    control: (action: QqMusicAction) => ipcRenderer.invoke(IPC.MUSIC_QQ_CONTROL, action),
  });
}
