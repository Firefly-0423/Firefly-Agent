import * as path from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope, type IpcScopeMainLike } from "../application/ipc-scope";
import type { CodeGitChangedPayload } from "../../shared/code-git-types";
import type { GitService } from "./git-service";

type IpcMainLike = {
  handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => void;
};

interface WindowLike {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: CodeGitChangedPayload): void };
}

type GitServiceSurface = Pick<GitService, "getStatusForSession" | "watchSession" | "unwatchSession" | "switchBranchForSession" | "commitForSession" | "pushForSession" | "onChanged">;

export type RegisterCodeGitIpcDeps = {
  service: GitServiceSurface;
  getWindows?: () => WindowLike[];
  /** 共享 scope：随应用退出统一注销；不传则包装 ipcMain。 */
  ipc?: IpcScope;
  ipcMain?: IpcMainLike;
};

/** 注册代码 Git 工作台的 IPC 通道，并把服务层的变更通知广播给所有存活窗口。 */
export function registerCodeGitIpc(deps: RegisterCodeGitIpcDeps): void {
  const scope: IpcScope = deps.ipc ?? createIpcScope((deps.ipcMain ?? ipcMain) as IpcScopeMainLike);
  const windowsProvider = deps.getWindows ?? (() => BrowserWindow.getAllWindows());
  const service = deps.service;

  scope.handle(IPC.CODE_GIT_STATUS, (_event, sessionId: unknown) => {
    if (!isUsableSessionId(sessionId)) return placeholderStatus();
    return service.getStatusForSession(sessionId);
  });

  scope.handle(IPC.CODE_GIT_WATCH, (_event, sessionId: unknown) => service.watchSession(requireSessionId(sessionId)));
  scope.handle(IPC.CODE_GIT_UNWATCH, (_event, sessionId: unknown) => service.unwatchSession(requireSessionId(sessionId)));

  scope.handle(IPC.CODE_GIT_SWITCH_BRANCH, (_event, payload: unknown) => {
    const body = payload as { sessionId?: unknown; branch?: unknown; create?: unknown } | null;
    if (typeof body?.branch !== "string") throw new Error("缺少分支名称");
    return service.switchBranchForSession(requireSessionId(body.sessionId), body.branch, body.create === true);
  });

  scope.handle(IPC.CODE_GIT_COMMIT, (_event, payload: unknown) => {
    const body = payload as { sessionId?: unknown; message?: unknown; paths?: unknown } | null;
    if (!isValidCommitBody(body)) throw new Error("提交参数无效");
    return service.commitForSession(requireSessionId(body.sessionId), body.message, body.paths);
  });

  scope.handle(IPC.CODE_GIT_PUSH, (_event, sessionId: unknown) => service.pushForSession(requireSessionId(sessionId)));

  service.onChanged((payload) => {
    for (const win of windowsProvider()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(IPC.CODE_GIT_CHANGED, payload);
    }
  });
}

function isUsableSessionId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function placeholderStatus() {
  const counters = Object.fromEntries(["added", "modified", "deleted", "renamed", "conflicted"].map((kind) => [kind, 0]));
  const fields: Array<[string, unknown]> = [
    ["sessionId", ""],
    ["state", "error"],
    ["message", "缺少会话标识"],
    ["executable", null],
    ["branch", null],
    ["files", []],
    ["summary", counters],
    ["ahead", 0],
    ["behind", 0],
  ];
  return Object.fromEntries(fields);
}

function isValidCommitBody(body: { message?: unknown; paths?: unknown } | null): body is { sessionId?: unknown; message: string; paths: string[] } {
  if (typeof body?.message !== "string") return false;
  const paths = body.paths;
  if (!Array.isArray(paths)) return false;
  return paths.every((entry) => typeof entry === "string" && isSafeRendererRelativePath(entry));
}

function requireSessionId(value: unknown): string {
  if (!isUsableSessionId(value)) throw new Error("缺少会话标识");
  return value;
}

/** 渲染进程给出的路径必须是仓库相对路径：非空、非绝对路径、不含 NUL，也不能跳出上级目录。 */
function isSafeRendererRelativePath(candidate: string): boolean {
  if (!candidate || path.isAbsolute(candidate) || candidate.includes("\0")) return false;
  const segments = candidate.replace(/\\/g, "/").split("/");
  return !segments.includes("..");
}
