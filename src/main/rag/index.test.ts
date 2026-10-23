import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EmbeddingProvider } from "./embedding";
const profile = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: { getPath: () => profile.root, getAppPath: () => profile.root } }));
const provider: EmbeddingProvider = { name: "garden-vectors", dims: 2,
  embed: async text => text.includes("shade") ? [0, 1] : [1, 0],
  embedBatch: async texts => texts.map(text => text.includes("shade") ? [0, 1] : [1, 0]) };
vi.mock("./embedding", async original => ({ ...await original<typeof import("./embedding")>(), getEmbeddingProvider: () => provider }));
import * as rag from "./index";
beforeEach(async () => {
  profile.root = mkdtempSync(join(tmpdir(), "ff-rag-api-"));
  await rag.initRAG();
});
afterEach(async () => { await rag.flushRAGStore(); rag.resetRAG(); rmSync(profile.root, { recursive: true, force: true }); });
it("makes user vectors writable once initialized", () => {
  expect(rag.isUserMemoryVectorStoreReady()).toBe(true);
});
it("returns an import identity and searchable chunks scoped to that import", async () => {
  expect(rag.hasImportedDocumentChunks("absent-garden-import")).toBe(false);
  const imported = await rag.importDocumentForTurn("shade plants\n\nshade gardening", "garden-guide.md");
  expect(imported.importId).toMatch(/^import-/);
  expect(imported.chunkCount).toBeGreaterThan(0);
  expect(rag.hasImportedDocumentChunks(imported.importId)).toBe(true);
  const results = await rag.searchImportedDocumentChunksForImportIds("shade", [imported.importId], 3);
  expect(results.length).toBeGreaterThan(0);
  expect(results.every(item => item.importId === imported.importId)).toBe(true);
});
it("assigns separate vector identities to equal text from different memories", async () => {
  const first = await rag.addL2MemoryVector("Grows mint", "memory:mint-a", { source: "garden-fixture" });
  const second = await rag.addL2MemoryVector("Grows mint", "memory:mint-b", { source: "garden-fixture" });
  expect(second).not.toBe(first);
  expect(rag.getEntriesBySource("user_memory").map(item => ({ id: item.id, l2Id: item.metadata?.l2Id })))
    .toEqual([{ id: first, l2Id: "memory:mint-a" }, { id: second, l2Id: "memory:mint-b" }]);
});
it("removes only explicitly requested user vectors", async () => {
  const first = await rag.addL2MemoryVector("Grows roses", "memory:rose");
  const second = await rag.addL2MemoryVector("Grows lilies", "memory:lily");
  expect(rag.deleteUserMemoryVectors([first])).toBe(1);
  expect(rag.getEntriesBySource("user_memory").map(item => item.id)).toEqual([second]);
});
it("returns only recallable memories whose current vector mapping is consistent", async () => {
  const { memoryStore } = await import("../memory/memory-store");
  const vectorIds: string[] = [];
  for (const [content, archived] of [["sunny active garden", false], ["shade archived garden", true]] as const) {
    const memory = await memoryStore.addL2Memory({ content, triggerText: "garden", sourceConversationId: "retrieval-session",
      isPinned: false, syncStatus: "pending_sync" });
    const vectorId = await rag.addMemory(content, "user_memory", { l2Id: memory.id });
    vectorIds.push(vectorId);
    await memoryStore.markL2SyncStatus(memory.id, "synced", vectorId);
    if (archived) await memoryStore.updateL2Status([memory.id], "archived");
  }
  const results = await rag.searchMemoryEntries("garden", "user_memory", 5);
  expect(results.map(item => item.id)).toEqual([vectorIds[0]]);
  expect(results.some(item => item.id === vectorIds[1])).toBe(false);
});
