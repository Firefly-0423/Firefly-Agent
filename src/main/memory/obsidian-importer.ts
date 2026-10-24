// Obsidian vault → PMRS 回流（双向同步的另一半）
//
// 监听 `<vault>/记忆/`：用户在 Obsidian 里改了某条记忆的 md，防抖 2 秒后解析变动文件，
// 取 frontmatter 里的 id 和正文，写回对应 L2Memory.content。只回流正文，
// status / weight / createdAt 等运行时字段一律不动。
//
// 防循环：写回期间 setImportingMemory(true)，memoryStore.save() 据此不再触发 notifyMemoryChanged；
// 再加上“内容没变就不写”，任何时序下都不会死循环。

import * as fs from "fs";
import * as path from "path";
import { memoryStore } from "./memory-store";
import { setImportingMemory } from "./obsidian-sync-flag";
import { addL2MemoryVector, deleteUserMemoryVectors } from "../rag/index";
import { logger, LogTag } from "../logger";
import type { L2Memory } from "./memory-types";

const L2_DIR = "记忆";
const RELATIONS_HEADING = "## 关联";
const IMPORT_DEBOUNCE_MS = 2000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ───── 解析 ─────

/** 取 frontmatter 中 id 的值，去掉导出器可能加的引号 */
function readFrontmatterId(fmLines: string[]): string | null {
  const hit = fmLines.map((line) => line.match(/^id:\s*(.+)$/)).find((m) => m !== null);
  if (!hit) return null;

  const value = hit[1].trim();
  const quoted = (q: string) => value.startsWith(q) && value.endsWith(q);
  if (quoted('"')) {
    // yamlString 会给含特殊字符的值包双引号并转义
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (quoted("'")) return value.slice(1, -1);
  return value;
}

export type ParsedL2Markdown = {
  /** 正文 content；null 表示结构无法识别（无 frontmatter 或无标题） */
  content: string | null;
  id: string | null;
};

/**
 * 解析 vault 里的 L2 md（结构见 obsidian-exporter 的 L2 生成函数）：
 * frontmatter 里取 id；正文是第一个一级标题之后、`## 关联` 之前（或到文件末尾）的内容，去掉末尾空白。
 */
export function parseL2Markdown(md: string): ParsedL2Markdown {
  const lines = md.split(/\r?\n/);

  let id: string | null = null;
  let bodyStart = 0;
  if (lines.length > 0 && lines[0].trim() === "---") {
    const closing = lines.findIndex((line, i) => i >= 1 && line.trim() === "---");
    if (closing !== -1) bodyStart = closing + 1;
    const fmEnd = closing === -1 ? lines.length : closing;
    id = readFrontmatterId(lines.slice(1, fmEnd));
  }

  if (bodyStart === 0) return { id, content: null }; // 没有 frontmatter，不回流
  if (!id) return { id: null, content: null }; // 有 frontmatter 但没有 id，无法对应到 L2

  const body = lines.slice(bodyStart);
  const titleAt = body.findIndex((line) => {
    const t = line.trim();
    return t.startsWith("# ") && !t.startsWith("## ");
  });
  if (titleAt === -1) return { id, content: null };

  // 标题后导出器会写一个空行，先跳过
  let from = titleAt + 1;
  while (from < body.length && body[from] === "") from++;

  const relationsAt = body.findIndex((line, i) => i >= from && line.trim() === RELATIONS_HEADING);
  const to = relationsAt === -1 ? body.length : relationsAt;

  return { id, content: body.slice(from, to).join("\n").trimEnd() };
}

// ───── 回写 ─────

export type ImportResult = {
  /** PMRS 中的记忆内容是否真的变了 */
  changed: boolean;
  /** 是否成功解析并尝试回写（即使内容未变也算 ok） */
  ok: boolean;
  id: string | null;
  reason?: "deleted" | "no-frontmatter-id" | "no-content" | "not-found";
};

/**
 * 解析一段 md 并写回 PMRS。回流标志只包住 memory-store 的快速写入，
 * 耗时的向量重建放在标志之外——否则期间别的对话产生的记忆写入会被误当成回流，漏掉自动导出。
 */
export async function importL2Markdown(md: string): Promise<ImportResult> {
  const parsed = parseL2Markdown(md);
  const { id, content } = parsed;
  const skipped = (reason: NonNullable<ImportResult["reason"]>, owner: string | null): ImportResult => ({ id: owner, ok: false, reason, changed: false });
  if (!id) return skipped("no-frontmatter-id", null);
  if (content === null) return skipped("no-content", id);

  let existing: L2Memory | undefined;
  setImportingMemory(true);
  try {
    const all = await memoryStore.getAllL2();
    existing = all.find((m: L2Memory) => m.id === id);
    if (!existing) return { id, ok: false, reason: "not-found", changed: false };
    if (existing.content === content) return { id, ok: true, changed: false };
    // 正文先落库并置 pending_sync：向量重建完成前旧向量不能被语义召回
    await memoryStore.updateL2Content(id, content);
  } finally {
    setImportingMemory(false);
  }

  const previousRagId = existing.ragId;
  try {
    const freshRagId = await addL2MemoryVector(content, id, { triggerText: existing.triggerText });
    await memoryStore.markL2SyncStatus(id, "synced", freshRagId);
    // 旧向量尽力清理：失败不影响回流结果（残留的旧向量已被 ragId 过滤屏蔽，启动时的一致性检查也会兜底）
    if (previousRagId && previousRagId !== freshRagId) {
      try {
        deleteUserMemoryVectors([previousRagId]);
      } catch (err) {
        logger.warn(LogTag.Firefly, `[obsidian-import] failed to delete stale vector for ${id}: ${errorText(err)}`);
      }
    }
  } catch (err) {
    // 重建失败：标记 sync_failed，让它暂时不可召回（与 writeL2 的失败路径一致）；
    // 启动一致性检查会发现“映射对、正文不同”并重试
    await memoryStore.markL2SyncStatus(id, "sync_failed", undefined, err);
    logger.warn(LogTag.Firefly, `[obsidian-import] vector rebuild failed for ${id}: ${errorText(err)}`);
  }
  return { id, ok: true, changed: true };
}

/** 读取并回流单个 md 文件；文件已不存在（被删）时静默跳过 */
export async function importL2File(filePath: string): Promise<ImportResult> {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return { id: null, ok: false, reason: "deleted", changed: false };
  }
  return importL2Markdown(text);
}

// ───── 监听 ─────

// 当前监听的运行状态；统一放在一个对象里，便于 stop 时整体复位
const live: {
  watcher: fs.FSWatcher | null;
  vaultPath: string | null;
  timer: ReturnType<typeof setTimeout> | null;
} = { watcher: null, vaultPath: null, timer: null };
const pendingFiles = new Set<string>();

function scheduleProcess(): void {
  if (live.timer) clearTimeout(live.timer);
  const fire = () => {
    live.timer = null;
    processPending().catch((err) => {
      logger.warn(LogTag.Firefly, `[obsidian-import] process failed: ${errorText(err)}`);
    });
  };
  live.timer = setTimeout(fire, IMPORT_DEBOUNCE_MS);
}

async function processPending(): Promise<void> {
  const vault = live.vaultPath;
  if (!vault) return;
  const queued = [...pendingFiles];
  pendingFiles.clear();
  if (!queued.length) return;

  // 回流标志由 importL2Markdown 统一管理（每个文件写回期间置位，结束即复位）
  let changedTotal = 0;
  for (const fileName of queued) {
    const outcome = await importL2File(path.join(vault, L2_DIR, fileName));
    changedTotal += outcome.changed ? 1 : 0;
  }
  if (changedTotal > 0) {
    logger.info(LogTag.Firefly, `[obsidian-import] imported ${changedTotal} changed memory(ies) from vault`);
  }
}

/** 开始监听 vault（绑定时调用），对同一路径重复调用是幂等的 */
export function startVaultWatcher(vaultPath: string): void {
  if (!vaultPath) return;
  if (live.watcher && live.vaultPath === vaultPath) return;
  stopVaultWatcher();

  const l2Dir = path.join(vaultPath, L2_DIR);
  if (!fs.existsSync(l2Dir)) {
    try {
      fs.mkdirSync(l2Dir, { recursive: true });
    } catch {
      // 建目录失败也照常去 watch，让 fs.watch 自己报错
    }
  }

  live.vaultPath = vaultPath;
  // Windows 的 os.tmpdir() 可能给 8.3 短路径，而 fs.watch 回调里是长路径，
  // 前缀不一致会触发 libuv 断言，所以先取规范化的长路径
  const realL2Dir = fs.realpathSync.native(l2Dir);
  const onChange = (_eventType: string, filename: string | Buffer | null) => {
    if (!filename || !String(filename).endsWith(".md")) return;
    pendingFiles.add(filename as string);
    scheduleProcess();
  };
  try {
    live.watcher = fs.watch(realL2Dir, { recursive: false, persistent: false }, onChange);
    live.watcher.on("error", (err) => {
      logger.warn(LogTag.Firefly, `[obsidian-import] watcher error: ${errorText(err)}`);
    });
    logger.info(LogTag.Firefly, `[obsidian-import] watcher started on ${l2Dir}`);
  } catch (err) {
    logger.warn(LogTag.Firefly, `[obsidian-import] fs.watch failed: ${errorText(err)}`);
    live.watcher = null;
    live.vaultPath = null;
  }
}

/** 停止监听（解绑时调用） */
export function stopVaultWatcher(): void {
  if (live.timer) {
    clearTimeout(live.timer);
    live.timer = null;
  }
  const current = live.watcher;
  if (current) {
    live.watcher = null;
    try {
      current.close();
    } catch {
      // 关闭失败无需处理
    }
  }
  pendingFiles.clear();
  if (live.vaultPath) {
    logger.info(LogTag.Firefly, `[obsidian-import] watcher stopped`);
    live.vaultPath = null;
  }
}

export const isVaultWatcherActive = (): boolean => live.watcher !== null;

export const getWatchedVaultPath = (): string | null => live.vaultPath;

// 供测试之间重置内部状态
export function _resetForTest(): void {
  stopVaultWatcher();
  setImportingMemory(false);
}
