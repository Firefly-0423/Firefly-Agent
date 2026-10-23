import * as path from "node:path";
import { app, ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { buildMusicTools } from "../orchestrator/tools/music-tools";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { createQqMusicExecutor, QqMusicService, type QqMusicAction } from "./qqmusic-service";

export interface MusicBootstrap {
  service: QqMusicService;
  isShuttingDown(): boolean;
  shutdown(): Promise<{ transportClosed: boolean; processTreeExited: boolean; runtimeRemoved: boolean }>;
}

export function resolveQqMusicScriptPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "music", "qqmusic_gsmtc.ps1")
    : path.join(app.getAppPath(), "src", "main", "music", "scripts", "qqmusic_gsmtc.ps1");
}

export function bootstrapMusicService(options: { enabled?: boolean } = {}): MusicBootstrap {
  const service = new QqMusicService(createQqMusicExecutor(resolveQqMusicScriptPath()));
  const tools = buildMusicTools(service);
  // 工具在设置同步之后才注册，这里按当前开关落位，避免关闭后重启又变回可用。
  for (const tool of tools) tool.enabled = options.enabled ?? true;
  for (const tool of tools) toolRegistry.register(tool);
  ipcMain.handle(IPC.MUSIC_QQ_GET_STATUS, () => service.getState());
  ipcMain.handle(IPC.MUSIC_QQ_CONTROL, (_event, action: QqMusicAction) => {
    if (!["play", "pause", "toggle", "next", "previous"].includes(action)) throw new Error("QQ_MUSIC_INVALID_ACTION");
    return service.control(action);
  });

  let stopping = false;
  return {
    service,
    isShuttingDown: () => stopping,
    shutdown: async () => {
      // 重复调用直接回报"已经全部收尾"，不会再次拆除
      if (stopping) return { transportClosed: true, processTreeExited: true, runtimeRemoved: true };
      stopping = true;
      ipcMain.removeHandler(IPC.MUSIC_QQ_GET_STATUS);
      ipcMain.removeHandler(IPC.MUSIC_QQ_CONTROL);
      for (const t of tools) toolRegistry.unregister(t.id);
      return service.shutdown();
    },
  };
}
