import * as fs from "fs";
import { getRagStorePath } from "../settings-store";
import { memoryStore } from "./memory-store";
import type { L0Profile, L1Profile, ReflectionLog } from "./memory-types";

export type MemoryPanelItem = {
  meta: string;
  body: string;
  title: string;
  id: string;
};

export type ImportedDocItem = {
  lastImportedAt: number;
  chunkCount: number;
  fileName: string;
  importId: string | null;
};

const REFLECTION_TITLES: Record<ReflectionLog["type"], string> = {
  compression: "片段压缩",
  l0_update: "画像更新",
  l1_update: "近况更新",
};

const toPanelItem = (log: ReflectionLog): MemoryPanelItem => ({
  id: log.id,
  title: REFLECTION_TITLES[log.type] ?? log.type,
  body: log.details ? [log.summary, log.details].join("\n") : log.summary,
  meta: new Date(log.createdAt).toLocaleString(),
});

type MemoryPanelData = {
  reflections: MemoryPanelItem[];
  importedDocs: ImportedDocItem[];
  l2: unknown[];
  l1: L1Profile;
  l0: L0Profile;
};

export async function loadMemoryPanelData(): Promise<MemoryPanelData> {
  const loads = [memoryStore.getL0(), memoryStore.getL1(), memoryStore.getAllL2(), memoryStore.getReflectionLogs()] as const;
  const [l0, l1, l2, logs] = await Promise.all(loads);
  const { importedDocs } = await loadImportedDocumentPanelData();

  const newestFirst = <T extends { createdAt: number }>(a: T, b: T): number => b.createdAt - a.createdAt;
  return {
    l0,
    l1,
    l2: l2.sort(newestFirst),
    importedDocs,
    reflections: [...logs].sort(newestFirst).map(toPanelItem),
  };
}

type RagEntryLike = {
  source?: string;
  createdAt?: number;
  metadata?: { fileName?: string; importId?: string };
};

/** 文档管理独立入口。混合 JSON 会被解析，但只选择 imported_doc，不访问旧个人记忆库。 */
export async function loadImportedDocumentPanelData(): Promise<{ importedDocs: ImportedDocItem[] }> {
  const storePath = getRagStorePath();
  try {
    if (!fs.existsSync(storePath)) return { importedDocs: [] };
    const entries = JSON.parse(fs.readFileSync(storePath, "utf8")) as RagEntryLike[];

    // 有 importId 的按它分组，旧数据没有 importId，退回按文件名分组
    const groups = new Map<string, ImportedDocItem>();
    for (const entry of entries.filter((e) => e.source === "imported_doc")) {
      const fileName = entry.metadata?.fileName || "未命名文档";
      const importId = entry.metadata?.importId as string | undefined;
      const groupKey = importId || "legacy:" + fileName;
      const stamp = entry.createdAt || 0;
      const group = groups.get(groupKey);
      if (group) {
        group.chunkCount += 1;
        group.lastImportedAt = Math.max(group.lastImportedAt, stamp);
      } else {
        groups.set(groupKey, { importId: importId || null, fileName, chunkCount: 1, lastImportedAt: stamp });
      }
    }
    return { importedDocs: Array.from(groups.values()).sort((a, b) => b.lastImportedAt - a.lastImportedAt) };
  } catch (error) {
    console.warn("[settings] load imported docs failed:", error);
    return { importedDocs: [] };
  }
}
