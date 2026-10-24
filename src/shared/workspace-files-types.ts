// 会话工作区文件接口的共享类型（主进程 IPC、preload、渲染层）。
// 失败只回传 code，文案由渲染层按 i18n 映射；error 字段仅存放意外错误的原始信息。

/**
 * 错误码：NO_WORKSPACE 会话未绑定工作区；OUT_OF_ROOT 路径越出根（含 symlink）；
 * NOT_FOUND 不存在或不可访问；IS_DIRECTORY 读取目标是目录；TOO_LARGE 超过预览上限；
 * BINARY 二进制（前 4KB 出现大量 \0）；LIST_FAILED / READ_FAILED / WRITE_FAILED 对应操作失败。
 */
export type WorkspaceFileErrorCode =
  | "WRITE_BUSY"
  | "WRITE_FAILED"
  | "READ_ONLY"
  | "UNSUPPORTED_TEXT"
  | "LINK_READ_ONLY"
  | "WORKSPACE_CHANGED"
  | "CONFLICT"
  | "CANCELLED"
  | "FORBIDDEN"
  | "INVALID_REQUEST"
  | "READ_FAILED"
  | "LIST_FAILED"
  | "BINARY"
  | "TOO_LARGE"
  | "IS_DIRECTORY"
  | "NOT_FOUND"
  | "OUT_OF_ROOT"
  | "NO_WORKSPACE";

/** 目录列表条目；relPath 相对工作区根，统一用 / 分隔，根目录为空字符串 */
export type WorkspaceFileEntry = { isDir: boolean; relPath: string; name: string };

type Failure<E extends object = object> = { ok: false; code: WorkspaceFileErrorCode } & E;

export type WorkspaceListResult =
  | Failure<{ error?: string }>
  | { ok: true; entries: WorkspaceFileEntry[]; truncated?: boolean };

export type WorkspaceReadResult =
  | Failure<{ error?: string }>
  | { ok: true; content: string; size: number; editVersion?: string; readOnlyReason?: WorkspaceFileErrorCode };

/** editVersion 由 Main 依据规范化文件标识与完整 UTF-8 字节生成 */
export type WorkspaceSaveRequest = { editVersion: string; content: string; relPath: string; sessionId: string };

export type WorkspaceSaveResult = Failure | { ok: true; content: string; size: number; editVersion: string };
