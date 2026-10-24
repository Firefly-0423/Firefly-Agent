// 会话工作区文件 IPC，服务于右侧文件树（按需展开）和文件预览。
//
// 访问范围：
// - 所有路径都以会话绑定的工作区根为准（chatsStore.getWorkspaceBinding）；
// - 先 resolve 再 realpath，且真实路径必须仍在根下，符号链接不能逃逸；
// - 以 "." 开头的条目不返回；目录项数量与预览体积都设上限；
// - 嗅探前 4KB，NUL 字节超过 5% 即视为二进制，不做预览。
//
// 出错时只返回 code（定义在 workspace-files-types），文案由渲染层按 i18n 生成。

import * as fs from "fs";
import * as path from "path";
import { BrowserWindow, dialog, type IpcMainInvokeEvent, type WebContents } from "electron";
import { inspectWorkspaceText, saveWorkspaceText } from "./workspace-file-editor";
import { IPC } from "../../shared/ipc-channels";
import type { WorkspaceFileEntry, WorkspaceListResult, WorkspaceReadResult, WorkspaceFileErrorCode } from "../../shared/workspace-files-types";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import * as chatsStore from "./chats-store";

/** 单次列目录最多返回的条目数，超出部分直接截掉 */
const LIST_MAX_ENTRIES = 1000;
/** 预览读取的体积上限，按 1 MiB 计 */
const READ_MAX_BYTES = 1024 * 1024;
/** 嗅探二进制时只看文件开头的这段字节 */
const BINARY_HEAD_BYTES = 4096;
/** 开头区域中 NUL 字节占比超过该比例就认定为二进制 */
const BINARY_NULL_RATIO = 0.05;

/** target 是否在 root 之内；Windows 下比较时忽略大小写 */
function isWithinRoot(root: string, target: string): boolean {
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const base = fold(root);
  const candidate = fold(target);
  return candidate === base || candidate.startsWith(base + path.sep);
}

/**
 * 把相对路径解析成根目录下的真实路径。
 * 出错时抛出带 code 的异常：NOT_FOUND 表示不存在，OUT_OF_ROOT 表示越界（包括经由符号链接越界）。
 */
async function resolveWithinRoot(root: string, relPath: string): Promise<{ rootReal: string; targetReal: string }> {
  // 统一为正斜杠并去掉前导斜杠，防止被当成绝对路径；".." 交给 resolve 与 realpath 处理
  const cleaned = String(relPath ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
  const rootReal = await fs.promises.realpath(root);
  const candidate = path.resolve(rootReal, cleaned);
  let targetReal: string;
  try {
    targetReal = await fs.promises.realpath(candidate);
  } catch {
    throw Object.assign(new Error("path not found"), { code: "NOT_FOUND" });
  }
  if (!isWithinRoot(rootReal, targetReal)) {
    throw Object.assign(new Error("path escapes workspace root"), { code: "OUT_OF_ROOT" });
  }
  return { rootReal, targetReal };
}

type ResolvedPath = { rootReal: string; targetReal: string };
type ResolveFailure = { ok: false; code: "OUT_OF_ROOT" | "NOT_FOUND" };

/** 解析路径，把异常统一折叠成失败结果，便于调用方直接返回 */
async function tryResolve(root: string, relPath: string): Promise<ResolvedPath | ResolveFailure> {
  try {
    return await resolveWithinRoot(root, relPath);
  } catch (err) {
    return { ok: false, code: (err as { code?: string }).code === "OUT_OF_ROOT" ? "OUT_OF_ROOT" : "NOT_FOUND" };
  }
}

/** 列出工作区内某个目录：目录在前、按名称排序、隐藏项过滤（导出给安全测试直接调用） */
export async function listDirectory(root: string, relPath: string): Promise<WorkspaceListResult> {
  const found = await tryResolve(root, relPath);
  if ("code" in found) return found;

  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(found.targetReal, { withFileTypes: true });
  } catch (err) {
    return { ok: false, code: "LIST_FAILED", error: err instanceof Error ? err.message : String(err) };
  }

  const entries: WorkspaceFileEntry[] = dirents
    .filter((dirent) => !dirent.name.startsWith("."))
    .map((dirent) => ({
      name: dirent.name,
      relPath: path.relative(found.rootReal, path.join(found.targetReal, dirent.name)).replaceAll("\\", "/"),
      // 符号链接目录按普通文件处理、不展开；真正打开预览时再由 realpath 做校验
      isDir: dirent.isDirectory(),
    }));
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));

  return { ok: true, entries: entries.slice(0, LIST_MAX_ENTRIES), truncated: entries.length > LIST_MAX_ENTRIES };
}

/** 读取工作区内的一个文件：先检查体积，再做二进制嗅探（导出给安全测试直接调用） */
export async function readFile(root: string, relPath: string): Promise<WorkspaceReadResult> {
  const found = await tryResolve(root, relPath);
  if ("code" in found) return found;

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(found.targetReal);
  } catch {
    return { ok: false, code: "NOT_FOUND" };
  }
  if (stat.isDirectory()) return { ok: false, code: "IS_DIRECTORY" };
  if (stat.size > READ_MAX_BYTES) return { ok: false, code: "TOO_LARGE" };

  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(found.targetReal);
  } catch (err) {
    return { ok: false, code: "READ_FAILED", error: err instanceof Error ? err.message : String(err) };
  }

  // 嗅探：只扫描开头一段，NUL 占比超过阈值即拒绝预览
  const sample = buf.subarray(0, Math.min(buf.length, BINARY_HEAD_BYTES));
  let zeros = 0;
  for (const byte of sample) if (byte === 0) zeros++;
  if (sample.length > 0 && zeros / sample.length > BINARY_NULL_RATIO) {
    return { ok: false, code: "BINARY" };
  }

  // Preview remains available for unsupported encodings/links; only a strict complete
  // snapshot can mint an edit version. Binding alone does not grant permission to save.
  try {
    const snapshot = inspectWorkspaceText(root, relPath);
    return { ok: true, content: snapshot.content, size: snapshot.size, editVersion: snapshot.editVersion };
  } catch (error) {
    const code = (error as { code?: WorkspaceFileErrorCode }).code;
    const readOnlyReason = code === "LINK_READ_ONLY" || code === "READ_ONLY" ? code : "UNSUPPORTED_TEXT";
    return { ok: true, content: buf.toString("utf8"), size: buf.length, readOnlyReason };
  }
}

export function registerWorkspaceFilesIpc(ipcOption?: IpcScope, options?: {
  getChatContents: () => WebContents | null | undefined;
}): { confirmBeforeShutdown(): Promise<boolean> } {
  const ipc = ipcOption ?? createIpcScope();
  const saving = new Set<WebContents>();
  const unloadGuarded = new WeakSet<WebContents>();
  const closeChecks = new Map<WebContents, (approved: boolean) => void>();
  let shutdownCheck: Promise<boolean> | undefined;
  const guardUnsavedWindow = (event: IpcMainInvokeEvent) => {
    const owner = options?.getChatContents();
    if (!owner || owner.isDestroyed() || event.sender !== owner || !event.senderFrame || event.senderFrame !== owner.mainFrame || unloadGuarded.has(owner)) return;
    unloadGuarded.add(owner);
    const preventUnload = (unload: { preventDefault(): void }) => {
      if (saving.has(owner) || owner.isDestroyed()) { closeChecks.get(owner)?.(false); return; }
      const window = BrowserWindow.fromWebContents(owner);
      if (!window || window.isDestroyed()) { closeChecks.get(owner)?.(false); return; }
      // Electron does not show the browser's default beforeunload prompt. Explicit
      // native confirmation is required before ignoring the renderer's dirty guard.
      const choice = dialog.showMessageBoxSync(window, {
        type: "warning", title: "未保存的修改 / Unsaved changes",
        message: "要放弃未保存的文件修改并离开吗？ / Discard unsaved file edits and leave?",
        detail: "未保存的草稿只保留在应用内存中。 / Unsaved drafts are only held in application memory.",
        buttons: ["继续编辑 / Keep editing", "放弃并离开 / Discard and leave"], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (choice === 1) unload.preventDefault();
      else closeChecks.get(owner)?.(false);
    };
    owner.on("will-prevent-unload", preventUnload);
    owner.once("destroyed", () => owner.removeListener("will-prevent-unload", preventUnload));
  };

  // 列目录 / 读文件只服务聊天主窗口的主 frame：其他窗口、浏览器来宾页或子 frame 不能借此枚举工作区。
  const fromChatWindow = (event: IpcMainInvokeEvent): boolean => {
    const owner = options?.getChatContents();
    return Boolean(owner && !owner.isDestroyed() && event.sender === owner && event.senderFrame && event.senderFrame === owner.mainFrame);
  };

  ipc.handle(IPC.WORKSPACE_FILES_LIST, (event: IpcMainInvokeEvent, payload: { sessionId?: string; relPath?: string }) => {
    if (!fromChatWindow(event)) return { ok: false as const, code: "FORBIDDEN" as const };
    const binding = payload?.sessionId ? chatsStore.getWorkspaceBinding(payload.sessionId) : undefined;
    if (!binding) return { ok: false as const, code: "NO_WORKSPACE" as const };
    return listDirectory(binding.workspaceRoot, payload.relPath ?? "");
  });

  ipc.handle(IPC.WORKSPACE_FILES_READ, (event: IpcMainInvokeEvent, payload: { sessionId?: string; relPath?: string }) => {
    if (!fromChatWindow(event)) return { ok: false as const, code: "FORBIDDEN" as const };
    if (!payload?.sessionId) return { ok: false as const, code: "NO_WORKSPACE" as const };
    const binding = chatsStore.getWorkspaceBinding(payload.sessionId);
    if (!binding) return { ok: false as const, code: "NO_WORKSPACE" as const };
    guardUnsavedWindow(event);
    return readFile(binding.workspaceRoot, payload.relPath ?? "");
  });

  ipc.handle(IPC.WORKSPACE_FILES_SAVE, async (event: IpcMainInvokeEvent, payload: unknown) => {
    const owner = options?.getChatContents();
    const validOwner = () => Boolean(owner && !owner.isDestroyed() && options?.getChatContents() === owner && event.sender === owner && event.senderFrame && event.senderFrame === owner.mainFrame);
    if (!owner || !validOwner()) return { ok: false, code: "FORBIDDEN" };
    if (saving.has(owner)) return { ok: false, code: "WRITE_BUSY" };
    const window = BrowserWindow.fromWebContents(owner);
    if (!window || window.isDestroyed()) return { ok: false, code: "FORBIDDEN" };
    guardUnsavedWindow(event);
    saving.add(owner);
    let active = true;
    const invalidate = () => { active = false; };
    const navigation = (details: { isMainFrame: boolean }) => { if (details.isMainFrame) invalidate(); };
    owner.on("did-start-navigation", navigation);
    owner.on("render-process-gone", invalidate);
    owner.on("destroyed", invalidate);
    try {
      return await saveWorkspaceText({
        getBinding: chatsStore.getWorkspaceBinding,
        isCurrent: () => active && validOwner(),
        confirm: async ({ workspaceRoot, relPath, size }) => {
          const answer = await dialog.showMessageBox(window, {
            type: "question", title: "保存工作区文件 / Save workspace file",
            message: `保存对此文件的修改？ / Save changes to this file?\n${relPath}`,
            detail: `工作区 / Workspace: ${workspaceRoot}\n${size} bytes\n仅允许本次保存；不会授予整个工作区写权限。\nThis approves this save only. It does not grant workspace-wide write access.`,
            buttons: ["取消 / Cancel", "保存 / Save"], defaultId: 0, cancelId: 0, noLink: true,
          });
          return answer.response === 1;
        },
      }, payload);
    } finally {
      saving.delete(owner);
      owner.removeListener("did-start-navigation", navigation);
      owner.removeListener("render-process-gone", invalidate);
      owner.removeListener("destroyed", invalidate);
    }
  });

  return {
    confirmBeforeShutdown() {
      if (shutdownCheck) return shutdownCheck;
      const owner = options?.getChatContents();
      if (!owner || owner.isDestroyed()) return Promise.resolve(true);
      if (saving.has(owner)) return Promise.resolve(false);
      const window = BrowserWindow.fromWebContents(owner);
      if (!window || window.isDestroyed()) return Promise.resolve(true);
      // Close the actual renderer BEFORE any runtime/IPC cleanup. Its existing
      // native dirty decision either keeps a usable window or really closes it.
      shutdownCheck = new Promise<boolean>(resolve => {
        let settled = false;
        const finish = (approved: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          window.removeListener("closed", closed);
          closeChecks.delete(owner);
          resolve(approved);
        };
        const closed = () => finish(true);
        const timeout = setTimeout(() => finish(false), 5000);
        timeout.unref?.();
        closeChecks.set(owner, finish);
        window.once("closed", closed);
        try { window.close(); } catch { finish(false); }
      }).finally(() => { shutdownCheck = undefined; });
      return shutdownCheck;
    },
  };
}
