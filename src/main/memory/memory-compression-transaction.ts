import type { L2MemoryStatus } from "./memory-types";

export type CompressionSource = {
  status: L2MemoryStatus;
  id: string;
  ragId?: string;
};

export type CompressionTransactionInput = {
  sources: CompressionSource[];
  sourceConversationId: string;
  triggerText: string;
  content: string;
}

type SummaryDraft = {
  isPinned: false;
  isSummary: true;
  syncStatus: "pending_sync";
  subEntryIds: string[];
  content: string;
  triggerText: string;
  sourceConversationId: string;
};

export type CompressionTransactionDeps = {
  warn(message: string, error: unknown): void;
  deleteVectors(ids: string[]): Promise<unknown> | unknown;
  createSummary(input: SummaryDraft): Promise<{ id: string }>;
  deactivateSummary(id: string): Promise<void>;
  deleteSummary(id: string): Promise<void>;
  archiveSources(ids: string[]): Promise<void>;
  restoreSources(sources: CompressionSource[]): Promise<void>;
  markSummarySynced(l2Id: string, ragId: string): Promise<unknown>;
  addSummaryVector(
    text: string,
    l2Id: string,
    metadata: Record<string, unknown>,
  ): Promise<string>;
};

/** 回滚时每一步都独立容错：失败只记警告，继续下一步 */
async function bestEffort(step: () => unknown, failureMessage: string, deps: CompressionTransactionDeps): Promise<void> {
  try {
    await step();
  } catch (rollbackError) {
    deps.warn(failureMessage, rollbackError);
  }
}

export async function commitMemoryCompression(input: CompressionTransactionInput, deps: CompressionTransactionDeps): Promise<{ summaryId: string; ragId: string }> {
  const sourceIds = input.sources.map((s) => s.id);
  // 键的先后顺序会原样落进 memory.json，保持 content → … → syncStatus
  const draft: SummaryDraft = Object.assign(
    { content: input.content, triggerText: input.triggerText },
    { sourceConversationId: input.sourceConversationId },
    { isPinned: false as const, isSummary: true as const },
    { subEntryIds: sourceIds, syncStatus: "pending_sync" as const },
  );
  const summary = await deps.createSummary(draft);

  let vectorId: string | undefined;
  let archiving = false;
  try {
    vectorId = await deps.addSummaryVector(input.content, summary.id, {
      isSummary: true,
      subEntryIds: sourceIds,
      source: "memory_compressor",
    });
    await deps.markSummarySynced(summary.id, vectorId);
    archiving = true;
    await deps.archiveSources(sourceIds);
  } catch (error) {
    await bestEffort(() => deps.deactivateSummary(summary.id), "Failed to deactivate rolled-back memory summary", deps);
    if (archiving) {
      await bestEffort(
        () => deps.restoreSources(input.sources),
        "Failed to restore source memories after compression rollback",
        deps,
      );
    }
    if (vectorId) {
      const orphan = vectorId;
      await bestEffort(() => deps.deleteVectors([orphan]), "Failed to delete rolled-back memory summary vector", deps);
    }
    await bestEffort(() => deps.deleteSummary(summary.id), "Failed to delete rolled-back memory summary", deps);
    throw error;
  }

  const staleRagIds: string[] = [];
  for (const { ragId } of input.sources) {
    if (typeof ragId === "string" && ragId.length > 0) staleRagIds.push(ragId);
  }
  await bestEffort(() => deps.deleteVectors(staleRagIds), "Failed to clean archived memory vectors", deps);

  return { summaryId: summary.id, ragId: vectorId };
}
