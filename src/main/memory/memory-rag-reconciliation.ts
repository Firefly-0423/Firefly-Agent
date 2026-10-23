import * as fs from "fs";
import * as path from "path";
import type { L2Memory } from "./memory-types";

export type ReconciliationVector = {
  metadata?: Record<string, unknown>;
  text: string;
  id: string;
};

export type MemoryRagReconciliationDeps = {
  warn(message: string, error: unknown): void;
  backup(): Promise<void>;
  getVectors(): ReconciliationVector[];
  getMemories(): Promise<L2Memory[]>;
  deleteVectors(ids: string[]): Promise<unknown> | unknown;
  markSynced(l2Id: string, ragId: string): Promise<unknown>;
  markSyncFailed(l2Id: string, error: unknown): Promise<unknown>;
  addVector(
    text: string,
    l2Id: string,
    metadata: Record<string, unknown>,
  ): Promise<string>;
};

export type MemoryRagReconciliationReport = {
  changed: boolean;
  failed: number;
  deleted: number;
  relinked: number;
  rebuilt: number;
};

/** 把 memory.json 与向量库文件复制到备份目录，每类只留最近 retention 份（至少 1 份） */
export function backupMemoryRagFiles(userDataDir: string, timestamp = Date.now(), retention = 3): void {
  const candidates: Array<{ file: string; prefix: string }> = [
    { file: path.join(userDataDir, "memory.json"), prefix: "memory" },
    { file: path.join(userDataDir, "rag-data", "memory-store.json"), prefix: "memory-store" },
  ];
  const present = candidates.filter(({ file }) => fs.existsSync(file));
  if (!present.length) return;

  const dir = path.join(userDataDir, "memory-reconcile-backups");
  fs.mkdirSync(dir, { recursive: true });
  const keep = Math.max(1, retention);
  present.forEach(({ file, prefix }) => {
    fs.copyFileSync(file, path.join(dir, `${prefix}.${timestamp}.json`));
    const names = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(`${prefix}.`) && n.endsWith(".json"))
      .sort();
    const surplus = Math.max(0, names.length - keep);
    names.slice(0, surplus).forEach((n) => fs.rmSync(path.join(dir, n)));
  });
}

const canBeRecalled = (m: L2Memory): boolean => m.status === "active" || m.status === "aging";

export async function reconcileMemoryRag(deps: MemoryRagReconciliationDeps): Promise<MemoryRagReconciliationReport> {
  const memories = await deps.getMemories();
  const vectors = deps.getVectors();
  const byId = new Map<string, ReconciliationVector>();
  vectors.forEach((v) => byId.set(v.id, v));

  const keptIds = new Set<string>();
  const toRelink: Array<{ l2Id: string; ragId: string }> = [];
  const toRebuild: L2Memory[] = [];

  memories.filter(canBeRecalled).forEach((memory) => {
    const vec = memory.ragId ? byId.get(memory.ragId) : undefined;
    // 映射和正文都要对得上；只对映射不对正文（如历史 Obsidian 回流没重建向量）也要重建
    const healthy = vec !== undefined && vec.metadata?.l2Id === memory.id && vec.text === memory.content;
    if (!healthy) {
      toRebuild.push(memory);
      return;
    }
    keptIds.add(vec.id);
    if (memory.syncStatus !== "synced") toRelink.push({ l2Id: memory.id, ragId: vec.id });
  });

  const orphanIds = vectors.map((v) => v.id).filter((id) => !keptIds.has(id));
  const needsWork = toRelink.length > 0 || toRebuild.length > 0 || orphanIds.length > 0;
  const report: MemoryRagReconciliationReport = { changed: needsWork, failed: 0, deleted: 0, relinked: 0, rebuilt: 0 };
  if (!report.changed) return report;

  await deps.backup();

  for (const { l2Id, ragId } of toRelink) {
    try {
      await deps.markSynced(l2Id, ragId);
      report.relinked++;
    } catch (error) {
      report.failed++;
      deps.warn(`Failed to relink memory ${l2Id}`, error);
    }
  }

  for (const memory of toRebuild) {
    try {
      const newRagId = await deps.addVector(memory.content, memory.id, {
        source: "memory_reconciliation",
        isSummary: memory.isSummary === true,
        subEntryIds: memory.subEntryIds ?? [],
      });
      await deps.markSynced(memory.id, newRagId);
      report.rebuilt++;
    } catch (error) {
      report.failed++;
      await deps.markSyncFailed(memory.id, error);
      deps.warn(`Failed to rebuild memory vector ${memory.id}`, error);
    }
  }

  if (orphanIds.length) {
    try {
      await deps.deleteVectors(orphanIds);
      report.deleted = orphanIds.length;
    } catch (error) {
      report.failed++;
      deps.warn("Failed to delete stale user memory vectors", error);
    }
  }

  return report;
}
