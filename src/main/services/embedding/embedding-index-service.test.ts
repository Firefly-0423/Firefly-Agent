import { afterEach, beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ provider: vi.fn(), build: vi.fn(), manifest: vi.fn() }));
vi.mock("../../logging/logger", () => ({ logger: { info: vi.fn() }, LogTag: { StickerEmbed: "sticker" } }));
vi.mock("../../rag/embedding", () => ({ getEmbeddingProvider: deps.provider }));
vi.mock("../../stickers/sticker-embedding-cache", () => ({ buildCachedStickerEmbeddingIndex: deps.build }));
vi.mock("../../stickers/sticker-storage", () => ({ loadUserStickerManifest: deps.manifest }));
import { createEmbeddingIndexService } from "./embedding-index-service";
beforeEach(() => { vi.resetAllMocks(); deps.provider.mockReturnValue({ embed: vi.fn() }); deps.manifest.mockReturnValue([]); deps.build.mockResolvedValue([{ id: "a" }]); vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it("starts empty, publishes a built index and invalidates it", async () => {
  const service = createEmbeddingIndexService(); expect(service.getStickerEmbeddingIndex()).toBeNull(); service.refreshStickerEmbeddingIndex("test"); await Promise.resolve();
  expect(service.getStickerEmbeddingIndex()).toEqual([{ id: "a" }]); service.invalidateStickerEmbeddingIndex(); expect(service.getStickerEmbeddingIndex()).toBeNull();
});
it("disables matching if the provider disappears", async () => {
  const service = createEmbeddingIndexService(); service.refreshStickerEmbeddingIndex("first"); await Promise.resolve(); deps.provider.mockReturnValue(null); service.refreshStickerEmbeddingIndex("missing"); expect(service.getStickerEmbeddingIndex()).toBeNull(); expect(deps.build).toHaveBeenCalledOnce();
});
it.each([new Error("failed"), "failed"])("clears an index after a refresh failure %s", async error => {
  const service = createEmbeddingIndexService(); service.refreshStickerEmbeddingIndex("first"); await Promise.resolve(); deps.build.mockRejectedValue(error); service.refreshStickerEmbeddingIndex("failure"); await Promise.resolve(); expect(service.getStickerEmbeddingIndex()).toBeNull();
});
it.each([false, true])("ignores stale refresh completion (failure=%s)", async fail => {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  deps.build.mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
  const service = createEmbeddingIndexService(); service.refreshStickerEmbeddingIndex("old"); service.refreshStickerEmbeddingIndex("new"); await Promise.resolve();
  if (fail) reject(Error("old")); else resolve([{ id: "old" }]); await Promise.resolve(); expect(service.getStickerEmbeddingIndex()).toEqual([{ id: "a" }]);
});
it.each([undefined, 50])("schedules startup at delay %s", async delay => {
  vi.useFakeTimers(); const service = createEmbeddingIndexService(); service.scheduleStartupRefreshes(delay); await vi.advanceTimersByTimeAsync((delay ?? 1500) - 1); expect(deps.build).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1); expect(service.getStickerEmbeddingIndex()).toEqual([{ id: "a" }]);
});
