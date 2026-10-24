import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HybridRetriever } from "./retriever";
import { JsonVectorStore } from "./vectorstore";
import type { EmbeddingProvider } from "./embedding";

const resources: Array<{ folder: string; store: JsonVectorStore }> = [];
const provider: EmbeddingProvider = {
  name: "garden-vectors", dims: 2,
  embed: async text => /lily|deadline/.test(text) ? [0, 1] : [1, 0],
  embedBatch: async texts => texts.map(text => /lily|deadline/.test(text) ? [0, 1] : [1, 0]),
};
function database() {
  const folder = mkdtempSync(join(tmpdir(), "ff-retrieval-")), store = new JsonVectorStore(folder);
  resources.push({ folder, store });
  return store;
}
afterEach(async () => {
  for (const { folder, store } of resources.splice(0)) { await store.flush(); rmSync(folder, { recursive: true, force: true }); }
});
it("bounds provider batch requests at sixteen imported chunks", async () => {
  const store = database(), embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
  await store.addBatch(Array.from({ length: 17 }, (_, index) => ({ text: `planting ${index}`, source: "imported_doc" })), { ...provider, embedBatch });
  expect(embedBatch).toHaveBeenCalledTimes(2);
  expect(embedBatch.mock.calls.map(call => call[0].length)).toEqual([16, 1]);
});
it("restricts turn retrieval to the requested import", async () => {
  const store = database();
  await store.addBatch([
    { text: "rose planting deadline in March", source: "imported_doc", metadata: { importId: "roses", fileName: "roses.md", chunkIndex: 0 } },
    { text: "lily planting deadline in June", source: "imported_doc", metadata: { importId: "lilies", fileName: "lilies.md", chunkIndex: 0 } },
  ], provider);
  const results = await new HybridRetriever(store, provider).retrieve("deadline", "imported_doc", 5, { importIds: ["lilies"] });
  expect(results.map(item => item.entry.text)).toEqual(["lily planting deadline in June"]);
});
it("filters excluded memories before modifying their recall statistics", async () => {
  const store = database();
  const [allowed, excluded] = store.addPreparedBatch([
    { text: "rose active note", source: "user_memory", embedding: [1, 0] },
    { text: "rose excluded note", source: "user_memory", embedding: [0.98, 0.1] },
  ]);
  const weight = excluded.weight, recalled = excluded.lastRecalledAt;
  const results = await new HybridRetriever(store, provider).retrieve("rose note", "user_memory", 5, { allowedEntryIds: [allowed.id] });
  expect(results.map(item => item.entry.id)).toEqual([allowed.id]);
  expect(excluded.weight).toBe(weight);
  expect(excluded.lastRecalledAt).toBe(recalled);
});
it("keeps distinct records even when their text and embeddings are equal", async () => {
  const store = database();
  const entries = store.addPreparedBatch(Array.from({ length: 2 }, () => ({ text: "identical garden note", source: "user_memory", embedding: [1, 0] })));
  const results = await new HybridRetriever(store, provider).retrieve("identical garden note", "user_memory", 5, { allowedEntryIds: entries.map(item => item.id) });
  expect(results.map(item => item.entry.id).sort()).toEqual(entries.map(item => item.id).sort());
});
it("retains lexical retrieval after warming more than two token-cache slices", async () => {
  const store = database();
  const entries = store.addPreparedBatch(Array.from({ length: 120 }, (_, index) => ({
    text: index % 2 ? `unrelated entry ${index}` : `rose note ${index} with lily content`, source: "imported_doc",
    embedding: [1, 0], metadata: { importId: "garden-warmup", chunkIndex: index },
  })));
  const retriever = new HybridRetriever(store, provider);
  await retriever.warmupBm25Tokens(entries);
  const results = await retriever.retrieve("lily content", "imported_doc", 5, { importIds: ["garden-warmup"] });
  expect(results.length).toBeGreaterThan(0);
  expect(results.every(item => item.entry.text.includes("lily"))).toBe(true);
});
