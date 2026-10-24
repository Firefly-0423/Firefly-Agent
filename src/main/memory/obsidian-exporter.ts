import * as fs from "fs";
import { fireflyExportManifest } from "../storage/firefly-data-paths";
import * as path from "path";
import { memoryStore } from "./memory-store";
import { entityGraph } from "./entity-graph";
import type { L0Profile, L1Profile, L2Memory, ReflectionLog, ConflictLog } from "./memory-types";
import { logger, LogTag } from "../logging/logger";
import { loadObsidianVaultConfig, saveObsidianVaultConfig, isVaultBound } from "./obsidian-vault-config";
import { isImportingMemory } from "./obsidian-sync-flag";

// vault 内的子目录名
const [L2_DIR, ENTITY_DIR, REFLECTION_DIR, CONFLICT_DIR] = ["记忆", "实体", "回顾", "冲突"];

const L2_STATUS_LABEL = Object.fromEntries([
  ["active", "活跃"],
  ["aging", "衰退"],
  ["archived", "归档"],
  ["superseded", "已替代"],
  ["merged", "已合并"],
]) as Record<L2Memory["status"], string>;

const ENTITY_TYPE_LABEL: Record<string, string> = {
  person: "人物",
  place: "地点",
  organization: "组织",
  preference: "偏好",
  concept: "概念",
};

const REFLECTION_TYPE_LABEL: Record<string, string> = {
  compression: "片段压缩",
  l0_update: "画像更新",
  l1_update: "近况更新",
};

export type ExportResult = {
  error?: string;
  fileCount?: number;
  outputPath?: string;
  ok: boolean;
};

type ExportManifest = {
  files: string[];
  exportedAt: number;
};

type EntityLink = { name: string; linkName: string };

// ───── 文本小工具 ─────

/** 把任意字符串变成可作文件名的形式（替换 / \ : * ? " < > |） */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|]/g, "_").trim();
  return cleaned.length > 0 ? cleaned : "_unnamed_";
}

/** 时间戳转 ISO 字符串；缺失给空串，转换失败退回数字本身 */
function formatTime(ts: number | undefined): string {
  let text = "";
  if (ts) {
    try {
      text = new Date(ts).toISOString();
    } catch {
      text = String(ts);
    }
  }
  return text;
}

/** YAML 标量：含特殊字符或换行时加双引号并转义 */
function yamlString(value: string): string {
  if (value === "") return '""';
  const needsQuotes = /[:#&*!|>'"%@`{}[\]]/.test(value) || value.includes("\n");
  if (!needsQuotes) return value;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** YAML 行内数组 */
function yamlArray(items: string[]): string {
  return items.length === 0 ? "[]" : "[" + items.map(yamlString).join(", ") + "]";
}

/** 以 frontmatter 开头：--- 行、字段行、--- 行、空行 */
function frontmatter(fields: string[]): string[] {
  return ["---", ...fields, "---", ""];
}

/** 二级标题段：标题、空行、正文、空行 */
function section(title: string, body: string): string[] {
  return [`## ${title}`, "", body, ""];
}

// ───── 链接索引 ─────

/** ragId → L2 id，用来把 conflictWith 里的 ragId 反查回 L2 */
function indexL2ByRagId(l2List: L2Memory[]): Map<string, string> {
  const index = new Map<string, string>();
  l2List.filter((m) => m.ragId).forEach((m) => index.set(m.ragId as string, m.id));
  return index;
}

/**
 * L2 id → 文件名/wikilink 名。
 * 不同条目的 slug 清洗后若重名，后来者加 -2、-3… 后缀，避免文件互相覆盖、wikilink 歧义、manifest 漏记。
 * 这里得到的是去重后的链接名，可能与 mem.slug 不同；frontmatter 里仍写原始 slug 作为用户可见标题。
 */
function indexLinkNamesById(l2List: L2Memory[]): Map<string, string> {
  const byId = new Map<string, string>();
  const taken = new Set<string>();

  for (const mem of l2List) {
    if (!mem.slug) continue;
    const base = sanitizeFileName(mem.slug);
    if (base === "_unnamed_") continue; // 清洗后什么都不剩，不占用链接名

    let candidate = base;
    for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
    taken.add(candidate);
    byId.set(mem.id, candidate);
  }
  return byId;
}

/** L2 的链接名：有 slug 用 slug，没有退回 id */
function l2LinkName(id: string, linkNames: Map<string, string>): string {
  return sanitizeFileName(linkNames.get(id) ?? id);
}

const wikilink = (target: string): string => `[[${target}]]`;

/** 正文里出现了哪些实体名（含别名） */
function entitiesMentionedIn(content: string, candidates: EntityLink[]): EntityLink[] {
  const lowered = content.toLowerCase();
  return candidates.filter((c) => mentionsName(lowered, c.name.toLowerCase()));
}

const ASCII_WORD_CHAR = /[a-z0-9]/;

/**
 * 忽略大小写的提及判断。纯 ASCII 的名称（如 IT、Al）要求前后都不是字母数字，避免命中 with、also 这类单词内部；
 * 含中文等其他文字的名称没有词边界，沿用子串匹配。
 */
function mentionsName(lowerContent: string, lowerName: string): boolean {
  if (!lowerName) return false;
  const wordLike = /^[ -~]+$/.test(lowerName) && ASCII_WORD_CHAR.test(lowerName);
  if (!wordLike) return lowerContent.includes(lowerName);
  for (let from = 0; ; ) {
    const at = lowerContent.indexOf(lowerName, from);
    if (at < 0) return false;
    const before = at > 0 ? lowerContent[at - 1] : "";
    const after = lowerContent[at + lowerName.length] ?? "";
    if (!ASCII_WORD_CHAR.test(before) && !ASCII_WORD_CHAR.test(after)) return true;
    from = at + 1;
  }
}

// ───── Markdown 生成 ─────

function renderL2(
  mem: L2Memory,
  ragIdToL2Id: Map<string, string>,
  linkNames: Map<string, string>,
  mentioned: EntityLink[],
): string {
  const tags = ["记忆", "片段", mem.status];
  if (mem.isPinned) tags.push("置顶");
  if (mem.isSummary) tags.push("总结");

  const fields: string[] = [`id: ${yamlString(mem.id)}`];
  if (mem.slug) fields.push(`slug: ${yamlString(mem.slug)}`);
  if (mem.sourceQuote) fields.push(`sourceQuote: ${yamlString(mem.sourceQuote)}`);
  fields.push(
    "type: 片段",
    `status: ${L2_STATUS_LABEL[mem.status]}`,
    `weight: ${mem.weight}`,
    `accessCount: ${mem.accessCount}`,
    `isPinned: ${mem.isPinned}`,
  );
  if (mem.isSummary) fields.push("isSummary: true");
  fields.push(`createdAt: ${formatTime(mem.createdAt)}`, `lastAccessedAt: ${formatTime(mem.lastAccessedAt)}`);
  if (mem.sourceConversationId) fields.push(`sourceConversationId: ${yamlString(mem.sourceConversationId)}`);
  if (mem.ragId) fields.push(`ragId: ${yamlString(mem.ragId)}`);
  fields.push(`tags: ${yamlArray(tags)}`);

  const out = [
    ...frontmatter(fields),
    `# ${mem.content.split("\n")[0].slice(0, 60) || "(空记忆)"}`,
    "",
    mem.content,
    "",
  ];

  // “关联”段里的 [[…]] 就是 Obsidian 图谱中的边
  const relations: string[] = [];
  const nameOf = (id: string): string => wikilink(l2LinkName(id, linkNames));

  if (mem.subEntryIds && mem.subEntryIds.length > 0) {
    relations.push(`- 压缩自：${mem.subEntryIds.map(nameOf).join(" ")}`);
  }
  if (mem.supersededBy) relations.push(`- 被替代为：${nameOf(mem.supersededBy)}`);
  if (mem.mergedInto) relations.push(`- 合并入：${nameOf(mem.mergedInto)}`);

  if (mem.conflictWith && mem.conflictWith.length > 0) {
    const targets = mem.conflictWith.map((ragId) => {
      const l2Id = ragIdToL2Id.get(ragId);
      return l2Id ? nameOf(l2Id) : `(未知 ragId: ${ragId})`;
    });
    relations.push(`- 冲突：${targets.join(" ")}`);
  }

  if (mentioned.length > 0) {
    relations.push(`- 提及实体：${mentioned.map((e) => wikilink(e.linkName)).join(" ")}`);
  }

  if (relations.length > 0) {
    out.push("## 关联", "", ...relations, "");
  }
  return out.join("\n");
}

type EntityPage = {
  name: string;
  type: string;
  mentionCount: number;
  firstMentionedAt: number;
  lastMentionedAt: number;
};

function renderEntity(entity: EntityPage, linkedL2Ids: string[], linkNames: Map<string, string>): string {
  const { name, type, mentionCount, firstMentionedAt, lastMentionedAt } = entity;
  const label = ENTITY_TYPE_LABEL[type] ?? type;
  const out = [
    ...frontmatter([
      `name: ${yamlString(name)}`,
      `type: ${label}`,
      `mentionCount: ${mentionCount}`,
      `firstMentionedAt: ${formatTime(firstMentionedAt)}`,
      `lastMentionedAt: ${formatTime(lastMentionedAt)}`,
      `tags: ${yamlArray(["实体", label])}`,
    ]),
    `# ${name}`,
    "",
    `**类型**：${label}`,
    "",
    `**提及次数**：${mentionCount}`,
    "",
  ];
  if (linkedL2Ids.length > 0) {
    out.push("## 出现于", "");
    linkedL2Ids.forEach((id) => out.push(`- ${wikilink(l2LinkName(id, linkNames))}`));
    out.push("");
  }
  return out.join("\n");
}

function renderL0(l0: Pick<L0Profile, "preferredName" | "occupation" | "longTermInterests" | "language" | "permanentNote">): string {
  const out = [
    ...frontmatter([
      "type: 画像",
      `preferredName: ${yamlString(l0.preferredName)}`,
      `occupation: ${yamlString(l0.occupation)}`,
      `language: ${yamlString(l0.language)}`,
      `tags: ${yamlArray(["画像", "L0"])}`,
    ]),
    "# 用户画像",
    "",
  ];
  if (l0.preferredName) out.push(`**称呼**：${l0.preferredName}`, "");
  if (l0.occupation) out.push(`**职业**：${l0.occupation}`, "");
  if (l0.longTermInterests) out.push(...section("长期兴趣", l0.longTermInterests));
  if (l0.permanentNote) out.push(...section("备注", l0.permanentNote));
  return out.join("\n");
}

function renderL1(l1: Pick<L1Profile, "recentGoals" | "recentPreferences" | "currentProject" | "generatedAt" | "roundCount">): string {
  const out = [
    ...frontmatter([
      "type: 近况",
      `generatedAt: ${formatTime(l1.generatedAt)}`,
      `roundCount: ${l1.roundCount}`,
      `tags: ${yamlArray(["近况", "L1"])}`,
    ]),
    "# 近期状态",
    "",
  ];
  if (l1.recentGoals) out.push(...section("近期目标", l1.recentGoals));
  if (l1.recentPreferences) out.push(...section("近期偏好", l1.recentPreferences));
  if (l1.currentProject) out.push(...section("当前项目", l1.currentProject));
  return out.join("\n");
}

function renderReflection(log: ReflectionLog): string {
  const label = REFLECTION_TYPE_LABEL[log.type] ?? log.type;
  const out = [
    ...frontmatter([
      `id: ${yamlString(log.id)}`,
      `type: ${label}`,
      `createdAt: ${formatTime(log.createdAt)}`,
      `tags: ${yamlArray(["回顾", label])}`,
    ]),
    `# ${label}`,
    "",
    `**时间**：${new Date(log.createdAt).toLocaleString()}`,
    "",
    "## 摘要",
    "",
    log.summary,
  ];
  if (log.details) out.push("", "## 详情", "", log.details);
  out.push("");
  return out.join("\n");
}

function renderConflict(log: ConflictLog, linkNames: Map<string, string>): string {
  return [
    ...frontmatter([
      `id: ${yamlString(log.id)}`,
      `status: ${log.status}`,
      `sourceL2Id: ${yamlString(log.sourceL2Id)}`,
      `targetL2Id: ${yamlString(log.targetL2Id)}`,
      `createdAt: ${formatTime(log.createdAt)}`,
      `confidence: ${log.confidence}`,
      `detector: ${log.detector}`,
      `tags: ${yamlArray(["冲突", log.status])}`,
    ]),
    "# 冲突记录",
    "",
    `**状态**：${log.status}`,
    `**检测器**：${log.detector}`,
    `**置信度**：${log.confidence}`,
    "",
    ...section("原因", log.reason),
    "## 涉及记忆",
    "",
    `- 源：${wikilink(l2LinkName(log.sourceL2Id, linkNames))}`,
    `- 目标：${wikilink(l2LinkName(log.targetL2Id, linkNames))}`,
    "",
  ].join("\n");
}

// ───── 导出主流程 ─────

type GraphEntity = {
  id: string;
  name: string;
  type: string;
  aliases: string[];
  mentionCount: number;
  firstMentionedAt: number;
  lastMentionedAt: number;
};

/** 删除上一次导出留下的文件；manifest 读不出来就整体失败，不去碰用户自己的文件 */
function removePreviouslyExported(manifestPath: string, outputDir: string): void {
  if (!fs.existsSync(manifestPath)) return;
  try {
    const previous = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ExportManifest;
    for (const rel of previous.files ?? []) {
      const abs = path.join(outputDir, rel);
      if (!fs.existsSync(abs)) continue;
      try {
        fs.unlinkSync(abs);
      } catch {
        // 单个文件删不掉不影响整体
      }
    }
  } catch {
    throw new Error("EXPORT_MANIFEST_READ_FAILED");
  }
}

/**
 * 把当前记忆库导出成 Obsidian vault。
 * @param outputDir 用户指定的输出目录（vault 根目录）
 */
export async function exportMemoryToObsidianVault(outputDir: string): Promise<ExportResult> {
  try {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const subDirs = [L2_DIR, ENTITY_DIR, REFLECTION_DIR, CONFLICT_DIR].map((d) => path.join(outputDir, d));
    const [l2Dir, entityDir, reflectionDir, conflictDir] = subDirs;

    const manifestPath = fireflyExportManifest(outputDir);
    const written: string[] = [];
    removePreviouslyExported(manifestPath, outputDir);

    for (const d of subDirs) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }

    const pending = [
      memoryStore.getL0(),
      memoryStore.getL1(),
      memoryStore.getAllL2(),
      memoryStore.getReflectionLogs(),
      memoryStore.getConflictLogs(),
    ] as const;
    const [l0, l1, l2List, reflectionLogs, conflictLogs] = await Promise.all(pending);

    const ragIdToL2Id = indexL2ByRagId(l2List);
    const linkNames = indexLinkNamesById(l2List);

    const emit = (dir: string, relDir: string | null, fileName: string, text: string): void => {
      fs.writeFileSync(path.join(dir, fileName), text, "utf8");
      written.push(relDir ? `${relDir}/${fileName}` : fileName);
    };

    emit(outputDir, null, "画像.md", renderL0(l0));
    emit(outputDir, null, "近况.md", renderL1(l1));

    let graphEntities: GraphEntity[] = [];
    try {
      graphEntities = entityGraph.load().entities;
    } catch {
      // 非 Electron 环境下 entity-graph 可能不可用
    }

    // 实体名与别名都能命中，别名指向主实体文件；长名在前，避免短名抢先匹配
    const entityLinks: EntityLink[] = [];
    for (const e of graphEntities) {
      entityLinks.push({ name: e.name, linkName: sanitizeFileName(e.name) });
      e.aliases.forEach((alias) => entityLinks.push({ name: alias, linkName: sanitizeFileName(e.name) }));
    }
    entityLinks.sort((a, b) => b.name.length - a.name.length);

    for (const mem of l2List) {
      const seen = new Set<string>();
      const unique = entitiesMentionedIn(mem.content, entityLinks).filter((hit) => {
        const dup = seen.has(hit.linkName);
        seen.add(hit.linkName);
        return !dup;
      });
      emit(l2Dir, L2_DIR, `${l2LinkName(mem.id, linkNames)}.md`, renderL2(mem, ragIdToL2Id, linkNames, unique));
    }

    // 反向：实体 → 提到它的 L2 id 列表
    const l2IdsByEntity = new Map<string, string[]>();
    for (const mem of l2List) {
      for (const hit of entitiesMentionedIn(mem.content, entityLinks)) {
        const ids = l2IdsByEntity.get(hit.linkName) ?? [];
        if (!ids.includes(mem.id)) ids.push(mem.id);
        l2IdsByEntity.set(hit.linkName, ids);
      }
    }

    for (const e of graphEntities) {
      const linkName = sanitizeFileName(e.name);
      const text = renderEntity(e, l2IdsByEntity.get(linkName) ?? [], linkNames);
      emit(entityDir, ENTITY_DIR, `${linkName}.md`, text);
    }

    for (const log of reflectionLogs) {
      emit(reflectionDir, REFLECTION_DIR, `${sanitizeFileName(log.id)}.md`, renderReflection(log));
    }
    for (const log of conflictLogs) {
      emit(conflictDir, CONFLICT_DIR, `${sanitizeFileName(log.id)}.md`, renderConflict(log, linkNames));
    }

    // manifest 记录本次写出的全部文件，下次导出前据此清理
    const manifest: ExportManifest = { exportedAt: Date.now(), files: written };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    logger.info(LogTag.Firefly, `[obsidian-export] exported ${written.length} files to ${outputDir}`);

    return { ok: true, outputPath: outputDir, fileCount: written.length };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(LogTag.Firefly, `[obsidian-export] failed: ${reason}`);
    return { ok: false, error: reason };
  }
}

// ───── 绑定模式（PMRS → Obsidian 单向同步）─────

export type SyncResult = {
  /** 未绑定 vault 时为 true */
  skipped?: boolean;
  error?: string;
  fileCount?: number;
  vaultPath?: string;
  ok: boolean;
};

/** 导出到已绑定的 vault 并更新 lastSyncAt；未绑定返回 { ok: false, skipped: true } */
export async function syncToBoundVault(): Promise<SyncResult> {
  const { vaultPath } = loadObsidianVaultConfig();
  if (!vaultPath) return { ok: false, skipped: true, error: "未绑定 vault" };

  const outcome = await exportMemoryToObsidianVault(vaultPath);
  if (outcome.ok) {
    saveObsidianVaultConfig({ lastSyncAt: Date.now() });
    return { ok: true, vaultPath, fileCount: outcome.fileCount };
  }
  return { ok: false, error: outcome.error };
}

// ───── 防抖自动同步 ─────

let syncTimer: ReturnType<typeof setTimeout> | null = null;
const SYNC_DEBOUNCE_MS = 2000;

/**
 * 记忆写入后调用：已绑定 vault 且开启 autoSync 时，2 秒防抖后同步一次（连续写入只同步一次）。
 * 回流（Obsidian→PMRS）期间直接跳过以免双向循环；主防线是 memory-store.save() 里同步检查标志，这里是兜底。
 */
export function notifyMemoryChanged(): void {
  if (isImportingMemory()) return;
  if (!isVaultBound()) return;
  if (!loadObsidianVaultConfig().autoSync) return;

  const runSync = () => {
    syncTimer = null;
    void syncToBoundVault().then((r) => {
      if (r.ok) {
        logger.info(LogTag.Firefly, `[obsidian-sync] auto-synced ${r.fileCount} files to ${r.vaultPath}`);
        return;
      }
      if (r.skipped) return;
      logger.warn(LogTag.Firefly, `[obsidian-sync] auto-sync failed: ${r.error}`);
    });
  };
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, SYNC_DEBOUNCE_MS);
}
