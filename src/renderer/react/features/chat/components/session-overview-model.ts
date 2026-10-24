// 会话概览面板的纯数据层：把上下文快照、本会话的工具变更与子任务投影成卡片需要的结构。
// 不碰 IO、不猜状态：没有数据就返回 undefined / 空数组，由卡片决定是否显示。

import type { ContextUsageCategoryKey, ContextUsageSnapshot } from "../../../../../shared/context-usage";
import type { TaskDelegationDisplayRecord } from "../../../../../shared/chat-types";
import { workspaceRelativePath, type WorkspaceChangedFile, type WorkspaceRunOutput } from "../workspace/workspace-artifacts";
import { computeUsageRatio, resolveRingTone, type ContextUsageRingTone } from "./ContextUsageRing";

export interface OverviewContextRow {
  key: ContextUsageCategoryKey;
  tokens: number;
  /** 占已用 token 的百分比（四舍五入）；已用为 0 时缺省。 */
  share?: number;
  /** 占窗口容量的比例，只喂给分段条宽度。 */
  windowRatio: number;
}

export interface OverviewContext {
  totalTokens: number;
  windowTokens: number;
  /** 占窗口的百分比；窗口非法时缺省，由卡片只显示 token 数。 */
  usedPercent?: number;
  tone: ContextUsageRingTone;
  /** 从大到小排序、已滤掉 0；总和不超过窗口。 */
  rows: OverviewContextRow[];
  /** 窗口剩余；窗口非法或已用超出时缺省。 */
  freeTokens?: number;
}

export function buildContextOverview(usage: ContextUsageSnapshot | undefined): OverviewContext | undefined {
  if (!usage) return undefined;
  const ratio = computeUsageRatio(usage.totalTokens, usage.contextWindowTokens);
  const hasWindow = Number.isFinite(ratio);
  const rows = usage.categories
    .filter((category) => category.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map<OverviewContextRow>((category) => ({
      key: category.key,
      tokens: category.tokens,
      share: usage.totalTokens > 0 ? Math.round((category.tokens / usage.totalTokens) * 100) : undefined,
      windowRatio: hasWindow ? Math.min(1, category.tokens / usage.contextWindowTokens) : 0,
    }));
  return {
    totalTokens: usage.totalTokens,
    windowTokens: usage.contextWindowTokens,
    ...(hasWindow ? { usedPercent: Math.round(ratio * 100) } : {}),
    tone: resolveRingTone(ratio),
    rows,
    ...(hasWindow && usage.totalTokens <= usage.contextWindowTokens
      ? { freeTokens: usage.contextWindowTokens - usage.totalTokens } : {}),
  };
}

export interface OverviewChangedFile {
  file: string;
  kind: WorkspaceChangedFile["change"]["kind"];
  insertions: number;
  deletions: number;
  /** 最近一次改到该文件的结果与变更，用于点开对应 Diff。 */
  output: WorkspaceRunOutput;
  changed: WorkspaceChangedFile;
}

export interface OverviewChanges {
  files: OverviewChangedFile[];
  insertions: number;
  deletions: number;
}

/** 同一文件被多次修改时合并计数，展示以最近一次为准。 */
export function summarizeChanges(outputs: readonly WorkspaceRunOutput[]): OverviewChanges {
  const byFile = new Map<string, OverviewChangedFile>();
  for (const output of outputs) {
    for (const changed of output.files) {
      const { file, kind, insertions, deletions } = changed.change;
      const previous = byFile.get(file);
      byFile.set(file, {
        file,
        kind,
        insertions: (previous?.insertions ?? 0) + insertions,
        deletions: (previous?.deletions ?? 0) + deletions,
        output,
        changed,
      });
    }
  }
  const files = [...byFile.values()];
  return {
    files,
    insertions: files.reduce((sum, item) => sum + item.insertions, 0),
    deletions: files.reduce((sum, item) => sum + item.deletions, 0),
  };
}

/** A file the session produced: what the "产出" card lists. */
export interface OverviewOutputFile {
  /** As the tool reported it (absolute or project-relative). */
  file: string;
  /** Project-relative path to open it with, or null when it lies outside the project. */
  relPath: string | null;
  type: "code" | "text" | "image" | "data" | "other";
  /** The latest run that wrote it, and that write: the diff a row of the outputs panel opens. */
  output: WorkspaceRunOutput;
  changed: WorkspaceChangedFile;
}

const CODE = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|ps1|bat|css|scss|less|html?|vue|svelte|sql|lua|dart)$/i;
const TEXT = /\.(?:md|markdown|txt|rst|log|docx?|pdf|rtf)$/i;
const IMAGE = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const DATA = /\.(?:json|jsonl|ya?ml|toml|xml|csv|tsv|xlsx?|ini|env)$/i;

export function outputFileType(file: string): OverviewOutputFile["type"] {
  return CODE.test(file) ? "code" : TEXT.test(file) ? "text" : IMAGE.test(file) ? "image" : DATA.test(file) ? "data" : "other";
}

/**
 * The files this session wrote, newest first, each once: a file written again moves to the top, and one whose latest
 * change deleted it is no longer an output.
 */
export function summarizeOutputFiles(outputs: readonly WorkspaceRunOutput[], workspaceRoot?: string): OverviewOutputFile[] {
  const seen = new Set<string>();
  const files: OverviewOutputFile[] = [];
  for (const output of [...outputs].reverse()) {
    for (const changed of [...output.files].reverse()) {
      const { change } = changed;
      const key = change.file.replace(/\\/g, "/").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (change.kind === "deleted") continue;
      files.push({ file: change.file, relPath: workspaceRelativePath(change.file, workspaceRoot), type: outputFileType(change.file), output, changed });
    }
  }
  return files;
}

export interface OverviewRunningTask {
  task: TaskDelegationDisplayRecord;
  /** 该次委托所在的运行结果：续跑的 agent 沿用 taskId，只有它能指到"这一次"。 */
  output: WorkspaceRunOutput;
}

export interface OverviewTasks {
  running: OverviewRunningTask[];
  /** 已结束（完成 / 失败 / 取消）的数量。 */
  finished: number;
  failed: number;
}

/** 以 invocationId 去重，后出现的记录覆盖先出现的（同一委托的状态推进）。 */
export function summarizeTasks(outputs: readonly WorkspaceRunOutput[]): OverviewTasks {
  const byInvocation = new Map<string, OverviewRunningTask>();
  for (const output of outputs) {
    for (const task of output.tasks) byInvocation.set(task.invocationId, { task, output });
  }
  const entries = [...byInvocation.values()];
  return {
    running: entries.filter((entry) => entry.task.status === "running"),
    finished: entries.filter((entry) => entry.task.status !== "running").length,
    failed: entries.filter((entry) => entry.task.status === "failed").length,
  };
}
