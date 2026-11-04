import * as path from "node:path";
import { ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope, type IpcScopeMainLike } from "../application/ipc-scope";
import type { CodeGitChangedPayload } from "../../shared/code-git-types";
import type { GitService } from "./git-service";

type IpcMainLike = {
  handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => void;
};

/** The chat window's webContents: the only renderer that shows the Code Git panel. */
interface ChatContentsLike {
  isDestroyed(): boolean;
  readonly mainFrame: unknown;
  send(channel: string, payload: CodeGitChangedPayload): void;
}

type SenderLike = { sender?: unknown; senderFrame?: unknown } | null | undefined;

type GitServiceSurface = Pick<GitService, "getStatusForSession" | "watchSession" | "unwatchSession" | "switchBranchForSession" | "commitForSession" | "pushForSession" | "onChanged">;

export type RegisterCodeGitIpcDeps = {
  service: GitServiceSurface;
  getChatContents: () => ChatContentsLike | null | undefined;
  /** 共享 scope：随应用退出统一注销；不传则包装 ipcMain。 */
  ipc?: IpcScope;
  ipcMain?: IpcMainLike;
};

/**
 * 注册代码 Git 工作台的 IPC 通道。所有窗口共用同一个 preload，所以每个请求都要确认来自聊天窗口的主 frame，
 * 而不是其他窗口或嵌入的子 frame；变更通知也只发给聊天窗口。
 */
export function registerCodeGitIpc(deps: RegisterCodeGitIpcDeps): { dispose(): void } {
  const scope: IpcScope = deps.ipc ?? createIpcScope((deps.ipcMain ?? ipcMain) as IpcScopeMainLike);
  const service = deps.service;

  function liveChat(): ChatContentsLike | null {
    try {
      const contents = deps.getChatContents();
      return contents && !contents.isDestroyed() ? contents : null;
    } catch {
      return null;
    }
  }

  function requireChat(event: unknown): void {
    const chat = liveChat();
    const from = event as SenderLike;
    if (!chat || from?.sender !== chat || !from.senderFrame || from.senderFrame !== chat.mainFrame) {
      throw new Error("CODE_GIT_FORBIDDEN");
    }
  }

  scope.handle(IPC.CODE_GIT_STATUS, (event, sessionId: unknown) => {
    requireChat(event);
    if (!isUsableSessionId(sessionId)) return placeholderStatus();
    return service.getStatusForSession(sessionId);
  });

  scope.handle(IPC.CODE_GIT_WATCH, (event, sessionId: unknown) => {
    requireChat(event);
    return service.watchSession(requireSessionId(sessionId));
  });
  scope.handle(IPC.CODE_GIT_UNWATCH, (event, sessionId: unknown) => {
    requireChat(event);
    return service.unwatchSession(requireSessionId(sessionId));
  });

  scope.handle(IPC.CODE_GIT_SWITCH_BRANCH, (event, payload: unknown) => {
    requireChat(event);
    const body = payload as { sessionId?: unknown; branch?: unknown; create?: unknown } | null;
    if (typeof body?.branch !== "string") throw new Error("缺少分支名称");
    return service.switchBranchForSession(requireSessionId(body.sessionId), body.branch, body.create === true);
  });

  scope.handle(IPC.CODE_GIT_COMMIT, (event, payload: unknown) => {
    requireChat(event);
    const body = payload as { sessionId?: unknown; message?: unknown; paths?: unknown } | null;
    if (!isValidCommitBody(body)) throw new Error("提交参数无效");
    return service.commitForSession(requireSessionId(body.sessionId), body.message, body.paths);
  });

  scope.handle(IPC.CODE_GIT_PUSH, (event, sessionId: unknown) => {
    requireChat(event);
    return service.pushForSession(requireSessionId(sessionId));
  });

  const unsubscribe = service.onChanged((payload) => {
    liveChat()?.send(IPC.CODE_GIT_CHANGED, payload);
  });
  return { dispose: unsubscribe };
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
