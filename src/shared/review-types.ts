// 不可变的文件变更审查（Review）类型：主进程生成，渲染端消费。
// 快照是 Run 结束后（含崩溃恢复）生成一次的最终态，对比的是「变更前基线」与
// 「Run 结束时的当前文件」，而非任务启动瞬间。前端只渲染，不拼 diff、不读文件。
// 与 chat-types 中 ToolFileChange（逐工具、可变的即时反馈）职责分离。

// ---- 文件元信息与 diff ----

/** 文件大小与 SHA-1 内容哈希 */
export interface ReviewFileMeta {
  /** 字节数 */
  size: number;
  /** 十六进制 SHA-1 */
  hash: string;
}

/** inline diff 的单行，带新旧行号 */
export interface ReviewLine {
  type: "context" | "add" | "remove";
  /** 旧文件行号（从 1 起），add 行为 null */
  oldLine: number | null;
  /** 新文件行号（从 1 起），remove 行为 null */
  newLine: number | null;
  text: string;
}

/** 一段连续的变更区域 */
export interface ReviewHunk {
  /** 旧文件起始行（从 1 起） */
  oldStart: number;
  oldLines: number;
  /** 新文件起始行（从 1 起） */
  newStart: number;
  newLines: number;
  lines: ReviewLine[];
}

// ---- 单文件变更 ----

export type ReviewFileKind =
  | "modified" // 内容被改
  | "created" // 新建
  | "deleted" // 删除
  | "renamed" // 重命名或移动，可能伴随内容修改
  | "binary" // 二进制，只保留元信息
  | "large-text"; // 文本过大，未自动生成 diff

export interface ReviewFileChange {
  kind: ReviewFileKind;
  /** renamed 时是旧路径，其余情况是当前路径 */
  oldPath: string;
  /** renamed 时是新路径；deleted 时与 oldPath 相同（仅用于展示）；其余为当前路径 */
  newPath: string;
  /** 新增行数，binary/large-text 为 0 */
  additions: number;
  /** 删除行数，binary/large-text 为 0 */
  deletions: number;
  /** 结构化 hunk，binary/large-text 时省略 */
  hunks?: ReviewHunk[];
  /** 大小与哈希，供 binary/large-text 展示 */
  before?: ReviewFileMeta;
  after?: ReviewFileMeta;
}

// ---- 快照与恢复 ----

export type ReviewRunStatus = "completed" | "failed" | "cancelled" | "halted";

export interface ReviewSnapshot {
  runId: string;
  /** 毫秒时间戳 */
  startedAt: number;
  endedAt: number;
  status: ReviewRunStatus;
  files: ReviewFileChange[];
}

/** 恢复时某个文件被跳过或失败的原因 */
export interface ReviewRestoreDetail {
  path: string;
  reason: string;
}

/** 恢复到运行前的 IPC 返回体 */
export interface ReviewRestoreOutcome {
  /** 全部成功为 true（本就无法恢复而被跳过的也算成功） */
  ok: boolean;
  /** 成功恢复的文件数，含删除运行期间新建的文件 */
  restored: number;
  /** 无法恢复的文件，如只存了元数据的二进制基线 */
  skipped: ReviewRestoreDetail[];
  /** 恢复失败的文件，如 IO 错误 */
  failed: ReviewRestoreDetail[];
  /** 整体异常时的错误信息 */
  error?: string;
}
