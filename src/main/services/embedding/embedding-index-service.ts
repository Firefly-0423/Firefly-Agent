import { logger, LogTag } from "../../logging/logger";
import { getEmbeddingProvider } from "../../rag/embedding";
import { AUTO_SEND_STICKER_DESCRIPTIONS } from "../../stickers/sticker-descriptions";
import { buildCachedStickerEmbeddingIndex } from "../../stickers/sticker-embedding-cache";
import type { StickerEmbeddingEntry } from "../../stickers/sticker-embedder";
import { loadUserStickerManifest } from "../../stickers/sticker-storage";

export type EmbeddingIndexService = {
  scheduleStartupRefreshes(delayMs?: number): void;
  invalidateStickerEmbeddingIndex(): void;
  refreshStickerEmbeddingIndex(reason: string): void;
  getStickerEmbeddingIndex(): StickerEmbeddingEntry[] | null;
};
export function createEmbeddingIndexService(): EmbeddingIndexService {
  let current: StickerEmbeddingEntry[] | null = null;
  let generation = 0;
  const rebuild = async (ticket: number, cause: string): Promise<void> => {
    try {
      const encoder = getEmbeddingProvider();
      if (!encoder) {
        if (ticket === generation) current = null;
        console.warn("[StickerEmbedding] Model not found. Sticker matching disabled.");
        return;
      }
      const next = await buildCachedStickerEmbeddingIndex(encoder, AUTO_SEND_STICKER_DESCRIPTIONS, loadUserStickerManifest());
      if (ticket !== generation) return;
      current = next;
      logger.info(LogTag.StickerEmbed, `index ready (${cause}): ${next.length} entries`);
    } catch (failure) {
      if (ticket === generation) current = null;
      console.error("[StickerEmbedding] refresh failed:", failure instanceof Error ? failure.message : String(failure));
    }
  };
  const refresh = (cause: string) => { const ticket = ++generation; void rebuild(ticket, cause); };
  return {
    getStickerEmbeddingIndex: () => current,
    refreshStickerEmbeddingIndex: refresh,
    invalidateStickerEmbeddingIndex: () => { current = null; },
    scheduleStartupRefreshes: (delayMs = 1500) => { setTimeout(() => { refresh("startup"); }, delayMs); },
  };
}
