import * as fs from "fs";
import { join } from "path";
import { app } from "electron";
import {
  getEmbeddingProvider,
  resetEmbeddingProvider,
  EmbeddingProvider,
  switchEmbeddingModel as switchModel,
  getCurrentModelDims,
  EmbeddingDimensionMismatchError,
} from "./embedding";
import type { EmbeddingIndexMetadata } from "./vectorstore";
import { JsonVectorStore } from "./vectorstore";
import type { MemoryEntry } from "./vectorstore";
import { HybridRetriever } from "./retriever";
import { WorldbookManager } from "./worldbook";
import { logger, LogTag } from "../logging/logger";
export { INJECTION_HEADER, INJECTION_PREAMBLE } from "./worldbook-constants";
import { chunkText } from "./chunk";
import { feedEntityNamesToJieba } from "../memory/entity-graph";
import { isL2LocallyRecallable } from "../memory/memory-types";
import type { DocumentImportControl } from "./file-ingest";
import { findPromptPath } from "../storage/external-content-paths";

// ───────────── 模块级单例 ─────────────

const LEGACY_PERSONAL_SOURCES = new Set(["chat_history", "user_memory"]);
let personalMemoryMode: "legacy" | "smh" = "legacy";
let provider: EmbeddingProvider | null = null;
let worldbook: WorldbookManager | null = null;
let retriever: HybridRetriever | null = null;
let store: JsonVectorStore | null = null;

/** SMH 模式下旧的个人记忆来源已退役，访问即报错。 */
function assertSourceAvailable(source: string | undefined): void {
  const retired = personalMemoryMode === "smh" && !!source && LEGACY_PERSONAL_SOURCES.has(source);
  if (retired) throw new Error("MEMORY_LEGACY_RETIRED");
}

// 每轮对话递增，供 DMAE 统计重复窗口；世界书状态不持久化，重启归零可以接受
let worldbookTurnCounter = 0;

const getDataDir = (): string => join(app.getPath("userData"), "rag-data");

const newImportId = (): string => {
  const suffix = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 8);
  return `import-${Date.now()}-${suffix}`;
};

/** 内部直接读取向量库的条目数组（库本身没有公开该字段）。 */
const rawEntries = (): MemoryEntry[] => (store as unknown as { entries: MemoryEntry[] }).entries;

// ───────────── 初始化 ─────────────

export async function initRAG(
  ragMode: "auto" | "local" | "cloud" = "auto", cloudBaseUrl?: string, cloudApiKey?: string,
  embeddingModel?: string, cloudDimensions?: number,
  options: { personalMemoryMode?: "legacy" | "smh" } = {},
): Promise<void> {
  personalMemoryMode = options.personalMemoryMode ?? "legacy";
  const dataDir = getDataDir();
  provider = getEmbeddingProvider(ragMode, cloudBaseUrl, cloudApiKey, embeddingModel, cloudDimensions);
  // 历史混合文件仍整读整写；旧的个人条目保持原样，不搜索、不维护、不删除也不迁移。
  store = new JsonVectorStore(dataDir);
  // 向量检索依赖 embedding，没有 provider 就不建 retriever
  if (provider) retriever = new HybridRetriever(store, provider);

  worldbook = new WorldbookManager(
    findPromptPath("worldbook") ?? join(app.getPath("userData"), "empty-worldbook"),
    { stateFile: join(app.getPath("userData"), "worldbook-state.json") },
  );
  await worldbook.loadFromDirectory();

  // 把已有实体名灌进 jieba 自定义词典，避免伴侣的核心称呼被误切
  if (personalMemoryMode !== "smh") await feedEntityNamesToJieba();

  const suffix = provider ? "" : " [Vector retrieval disabled]";
  logger.info(LogTag.RAG, "initialized. Mode:", ragMode, "Provider:", provider?.name ?? "none", "Dims:", provider?.dims ?? "N/A", "Memories:", store.stats.total, suffix);
}

/** 受控退出（before-quit）时调用，把防抖中的数据写盘。 */
export async function flushRAGStore(): Promise<void> {
  await store?.flush();
}

/** 会话被强制结束（Windows session-end）时调用，同步落盘。 */
export function flushRAGStoreSync(): void {
  store?.flushSync();
}

// ───────────── 切换 embedding 模型（热切换） ─────────────

/** 模型缺失时把探测结果打到控制台，方便排查"放进 models/ 却没识别"。 */
function logMissingModelDiagnostics(modelKey: string): void {
  try {
    // 运行时 require，避免模块加载阶段的循环依赖
    const { getModelInstallStatusDetail } = require("./model-status") as typeof import("./model-status");
    const detail = getModelInstallStatusDetail("embedding", modelKey);
    const json = (value: unknown) => JSON.stringify(value);
    const lines = detail.existingProjectDir
      ? [
        `[Firefly] embedding model "${modelKey}" project directory exists but is incomplete.`,
        `  existingProjectDir: ${detail.existingProjectDir}`,
        `  requiredFiles:      ${json(detail.requiredFiles)}`,
        `  missingFiles:       ${json(detail.missingFiles)}`,
        "  HF cache fallback suppressed. Fix the files above, then retry.",
      ]
      : [
        `[Firefly] embedding model "${modelKey}" not detected anywhere.`,
        `  modelDirCandidates: ${json(detail.modelDirCandidates)}`,
        `  subPathCandidates:  ${json(detail.subPathCandidates)}`,
        `  requiredFiles:      ${json(detail.requiredFiles)}`,
        "  Drop the model files into one of the candidates above.",
      ];
    console.error(lines.join("\n"));
  } catch (diagErr) {
    console.error("[Firefly] model diagnostic log failed:", diagErr);
  }
}

export async function switchEmbeddingModel(modelKey: string): Promise<{ ok: boolean; clearedEntries: number; error?: string }> {
  try {
    switchModel(modelKey);
    const next = getEmbeddingProvider("auto", undefined, undefined, modelKey);

    if (!next) {
      logMissingModelDiagnostics(modelKey);
      return { ok: false, clearedEntries: 0, error: "Local embedding model not found. Cannot switch." };
    }

    const newDims = next.dims;

    // 已有向量维度与新模型不一致时需要清库重建
    let clearedEntries = 0;
    const existing = store
      ? ((store as any).entries as Array<{ embedding: number[]; source: string }> | undefined)
      : undefined;
    if (store && existing && existing.length > 0) {
      const oldDims = existing[0].embedding.length;
      if (oldDims !== newDims) {
        if (personalMemoryMode === "smh" && existing.some((e) => LEGACY_PERSONAL_SOURCES.has(e.source))) {
          return { ok: false, clearedEntries: 0, error: "MEMORY_LEGACY_RETIRED" };
        }
        clearedEntries = existing.length;
        // 内存与磁盘一并清空（同时取消防抖中的写入），避免旧维度向量被写回
        store.clearForRebuild();
        console.log("[RAG] dimension mismatch (" + oldDims + " → " + newDims + "), cleared " + clearedEntries + " entries");
        // 旧索引元数据作废，下次写入会重新生成
        const metaFile = join(getDataDir(), "memory-store-meta.json");
        if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile);
      }
    }

    provider = next;
    if (store) retriever = new HybridRetriever(store, provider);

    console.log("[RAG] switched embedding model to", modelKey, "dims:", newDims, "cleared:", clearedEntries);
    return { ok: true, clearedEntries };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[RAG] switch embedding model failed:", reason);
    return { ok: false, clearedEntries: 0, error: reason };
  }
}

/** 当前向量索引的元数据（只读），供设置页展示或诊断。 */
export function getIndexMetadata(): Readonly<EmbeddingIndexMetadata> | null {
  return store?.getIndexMeta() ?? null;
}

// ───────────── 记忆写入 ─────────────

export async function addMemory(text: string, source = "user_memory", metadata?: Record<string, unknown>): Promise<string> {
  // 空 source 在旧存储里表示全库去重，SMH 不允许它碰到退役记录
  assertSourceAvailable(source || "user_memory");
  if (!store || !provider) throw new Error("RAG not initialized");
  return (await store.add(text, source, provider, metadata)).id;
}

export async function addL2MemoryVector(text: string, l2Id: string, metadata?: Record<string, unknown>): Promise<string> {
  assertSourceAvailable("user_memory");
  if (!store || !provider) throw new Error("RAG not initialized");
  if (!l2Id.trim()) throw new Error("l2Id is required");
  const { id } = await store.addUnique(text, "user_memory", provider, { ...metadata, l2Id });
  return id;
}

// ───────────── 记忆检索 ─────────────

export async function searchMemory(query: string, source?: string, topK = 5, options?: { recordRecall?: boolean }): Promise<string[]> {
  const hits = await searchMemoryEntries(query, source, topK, options);
  return hits.map((hit) => hit.text);
}

type MemoryHit = { id: string; text: string; createdAt: number; score: number; metadata?: Record<string, unknown> };

export async function searchMemoryEntries(
  query: string, source?: string, topK = 5, options?: { recordRecall?: boolean },
): Promise<MemoryHit[]> {
  assertSourceAvailable(source);
  if (!retriever) return [];

  const hideLegacy = personalMemoryMode === "smh" && !source;
  let allowedEntryIds: string[] | undefined = hideLegacy
    ? rawEntries().filter((e) => !LEGACY_PERSONAL_SOURCES.has(e.source)).map((e) => e.id)
    : undefined;
  if (source === "user_memory") {
    try {
      const { memoryStore } = await import("../memory/memory-store");
      const l2Records = await memoryStore.getAllL2();
      const recallable = new Map(
        l2Records.filter(isL2LocallyRecallable).map((m) => [m.id, m]),
      );
      // 只放行仍被对应 L2 记忆引用且可召回的向量条目
      allowedEntryIds = getEntriesBySource("user_memory")
        .filter((entry) => {
          const l2Id = entry.metadata?.l2Id;
          return typeof l2Id === "string" && recallable.get(l2Id)?.ragId === entry.id;
        })
        .map((entry) => entry.id);
    } catch (err) {
      console.warn("[RAG] failed to resolve recallable user memories:", err);
      return [];
    }
  }

  const results = await retriever.retrieve(query, source, topK, { allowedEntryIds });
  const shouldRecord = options?.recordRecall !== false && personalMemoryMode !== "smh";
  if (shouldRecord) await recordUserMemoryRecalls(results);
  return results.map(({ entry, score }) => ({
    id: entry.id,
    text: entry.text,
    createdAt: entry.createdAt,
    score,
    metadata: entry.metadata,
  }));
}

/** 把本次召回命中的用户记忆在 L2 层记一次召回统计。 */
async function recordUserMemoryRecalls(results: Array<{ entry: MemoryEntry }>): Promise<void> {
  const recalled = new Set<string>();
  for (const { entry } of results) {
    const l2Id = entry.source === "user_memory" ? entry.metadata?.l2Id : undefined;
    if (typeof l2Id === "string" && l2Id.length > 0) recalled.add(l2Id);
  }
  if (recalled.size === 0) return;

  try {
    const { memoryStore } = await import("../memory/memory-store");
    for (const l2Id of recalled) await memoryStore.updateL2RecallStats(l2Id, 1);
  } catch (err) {
    console.warn("[RAG] failed to record user memory recall:", err);
  }
}

// 与 searchMemory 的区别：返回完整条目（含 createdAt / metadata），
// 让 recall_history 工具可以按时间排序并展示时间戳。
export async function searchHistoryEntries(query: string, topK = 5): Promise<Array<Omit<MemoryHit, "id">>> {
  assertSourceAvailable("chat_history");
  if (!retriever) return [];
  const results = await retriever.retrieve(query, "chat_history", topK);
  return results.map(({ entry, score }) => ({
    text: entry.text,
    createdAt: entry.createdAt,
    score,
    metadata: entry.metadata,
  }));
}

// ───────────── 世界书 ─────────────

/** 每轮对话打分：本轮用户输入 + 上一轮模型回复。 */
export function updateWorldbookActivation(userText: string, modelText: string, turn?: number): void {
  if (!worldbook) return;
  worldbook.updateActivation(userText, modelText, turn ?? ++worldbookTurnCounter);
}

/** 取 Active 条目内容（阈值门控后注入）。 */
export function getActiveWorldbookEntries(): string[] {
  return worldbook ? worldbook.getActiveEntries() : [];
}

/** 取本轮 cascade 触发的条目（不进 DMAE 状态表），带标题，格式便于与 Active 条目合并注入。 */
export function getCascadeWorldbookEntries(): string[] {
  if (!worldbook) return [];
  return worldbook.getCascadeEntries().map((entry) => {
    const title = entry.id.replace(/^wb_[^_]+_/, "").replace(/_/g, " ");
    return `【${title}】\n${entry.content}`;
  });
}

export function getPermanentWorldbookEntries(): string[] {
  return worldbook ? worldbook.getPermanentEntries() : [];
}

// ───────────── 文档导入 ─────────────

export type ImportedDocumentResult = { importId: string; chunkCount: number };

export type ImportedDocumentChunk = {
  text: string; score: number;
  fileName?: string; chunkIndex?: number; importId?: string;
};

export type PreparedDocumentEmbedding = { text: string; chunkIndex: number; embedding: number[] };

export async function appendPreparedDocumentBatch(fileName: string, importId: string, prepared: PreparedDocumentEmbedding[]): Promise<void> {
  if (!store) throw new Error("RAG not initialized");
  const added = store.addPreparedBatch(
    prepared.map(({ text, embedding, chunkIndex }) => ({
      text,
      embedding,
      source: "imported_doc",
      metadata: { fileName, chunkIndex, importId },
    })),
  );
  // 后台预热新条目的 BM25 分词，免得首次检索才付冷启动代价；不阻塞导入返回
  void retriever?.warmupBm25Tokens(added);
}

export async function importPreparedDocumentForTurn(fileName: string, prepared: PreparedDocumentEmbedding[]): Promise<ImportedDocumentResult> {
  if (!store) throw new Error("RAG not initialized");
  const importId = newImportId();
  await appendPreparedDocumentBatch(fileName, importId, prepared);
  // 嵌入已全部完成，成本高，立即落盘
  await store.flush();
  return { importId, chunkCount: prepared.length };
}

export async function importDocumentForTurn(text: string, fileName: string, control?: DocumentImportControl): Promise<ImportedDocumentResult> {
  if (!store || !provider) throw new Error("RAG not initialized");
  const chunks = chunkText(text, "doc_" + fileName);
  const total = chunks.length;
  control?.onProgress?.({ status: "chunking", completedChunks: total, totalChunks: total });
  if (control?.isCancelled?.()) throw new Error("cancelled");

  const importId = newImportId();
  control?.onProgress?.({ status: "embedding", completedChunks: 0, totalChunks: total });
  const items = chunks.map((c) => ({ text: c.text, source: "imported_doc", metadata: { fileName, chunkIndex: c.index, importId } }));
  const added = await store.addBatch(items, provider, { isCancelled: control?.isCancelled });
  // 嵌入已全部完成，成本高，立即落盘
  await store.flush();
  void retriever?.warmupBm25Tokens(added);
  return { importId, chunkCount: total };
}

export async function importDocument(text: string, fileName: string): Promise<number> {
  return (await importDocumentForTurn(text, fileName)).chunkCount;
}

export async function searchImportedDocumentChunksForImportIds(query: string, importIds: string[], topK = 6): Promise<ImportedDocumentChunk[]> {
  if (!retriever || !query.trim() || importIds.length === 0) return [];
  const results = await retriever.retrieve(query, "imported_doc", topK, { importIds });
  return results.map(({ entry, score }) => {
    const meta = entry.metadata;
    return {
      text: entry.text,
      score,
      fileName: typeof meta?.fileName === "string" ? meta.fileName : undefined,
      chunkIndex: typeof meta?.chunkIndex === "number" ? meta.chunkIndex : undefined,
      importId: typeof meta?.importId === "string" ? meta.importId : undefined,
    };
  });
}

// ───────────── 重置与查询 ─────────────

export function resetRAG(): void {
  personalMemoryMode = "legacy";
  store = retriever = worldbook = provider = null;
  resetEmbeddingProvider();
}

export function getRAGStats() { return store?.stats ?? { total: 0, sources: {} }; }

export function isUserMemoryVectorStoreReady(): boolean { return personalMemoryMode !== "smh" && !!store && !!provider; }

/** 某个 source 下全部向量条目（含 embedding），供片段压缩与聚类使用；调用方不要改动返回的 embedding。 */
export function getEntriesBySource(source: string): Array<{ id: string; text: string; embedding: number[]; createdAt: number; weight: number; metadata?: Record<string, unknown> }> {
  assertSourceAvailable(source);
  if (!store) return [];
  return rawEntries()
    .filter((e) => e.source === source)
    .map(({ id, text, embedding, createdAt, weight, metadata }) => ({ id, text, embedding, createdAt, weight, metadata }));
}

export function deleteUserMemoryVectors(ragIds: string[]): number {
  assertSourceAvailable("user_memory");
  if (store === null) throw new Error("RAG not initialized");
  return store.deleteEntriesByIds(ragIds, "user_memory");
}

export function deleteImportedDoc(importId: string, fileName?: string): number {
  if (store === null) throw new Error("RAG not initialized");
  return store.deleteImportedDoc(importId, fileName);
}

export function hasImportedDocumentChunks(importId: string): boolean { return store?.hasImportedDocumentChunks(importId) ?? false; }
