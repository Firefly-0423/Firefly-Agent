import * as fs from "fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./embedding", () => ({ getEmbeddingProvider: vi.fn(() => null) }));
vi.mock("fs", async importOriginal => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});
import { getEmbeddingProvider, type EmbeddingProvider } from "./embedding";
import { cosineSimilarity, JsonVectorStore } from "./vectorstore";

let dir: string;
let store: JsonVectorStore;
const provider = (): EmbeddingProvider => ({ name: "fixture", dims: 2, declaredDimensions: 2, embed: vi.fn(async () => [1, 0]), embedBatch: vi.fn(async texts => texts.map(() => [1, 0])) });
const item = (text: string, overrides: Record<string, unknown> = {}) => ({ text, source: "imported_doc", embedding: [1, 0], metadata: { importId: "one" }, ...overrides });
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-vectorstore-unit-"));
  store = new JsonVectorStore(dir);
});
afterEach(async () => {
  vi.restoreAllMocks(); await store.flush(); vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.mocked(getEmbeddingProvider).mockReturnValue(null);
});

describe("JsonVectorStore", () => {
  it("starts empty and computes normalized dot products including empty vectors", async () => {
    expect(store.stats).toEqual({ total: 0, sources: {} });
    expect(store.getIndexMeta()).toBeNull();
    expect(await store.search("empty")).toEqual([]);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0.6, 0.8], [0.6, 0.8])).toBe(1);
    expect(cosineSimilarity([1], [-1])).toBe(-1);
  });

  it("survives malformed data and metadata JSON", () => {
    fs.writeFileSync(path.join(dir, "memory-store.json"), "{broken");
    fs.writeFileSync(path.join(dir, "memory-store-meta.json"), "{broken");
    const loaded = new JsonVectorStore(dir);
    expect(loaded.stats.total).toBe(0);
    expect(loaded.getIndexMeta()).toBeNull();
  });

  it("preserves prepared batch order, metadata and timestamps across flush and reload", async () => {
    const entries = store.addPreparedBatch([item("a"), item("b", { source: "worldbook" })]);
    expect(entries.map(e => e.text)).toEqual(["a", "b"]);
    expect(new Set(entries.map(e => e.id)).size).toBe(2);
    expect(entries[0]).toMatchObject({ weight: 1, createdAt: Date.now(), lastRecalledAt: Date.now(), metadata: { importId: "one" } });
    expect(fs.existsSync(path.join(dir, "memory-store.json"))).toBe(false);
    await store.flush();
    expect(JSON.parse(fs.readFileSync(path.join(dir, "memory-store.json"), "utf8"))).toEqual(entries);
    expect(new JsonVectorStore(dir).stats).toEqual({ total: 2, sources: { imported_doc: 1, worldbook: 1 } });
    expect(fs.existsSync(path.join(dir, "memory-store.json.tmp"))).toBe(false);
  });

  it("flushSync persists changes and clean flushes do not create files", async () => {
    store.flushSync(); await store.flush();
    expect(fs.readdirSync(dir)).toEqual([]);
    store.addPreparedBatch([item("a")]); store.flushSync();
    expect(new JsonVectorStore(dir).stats.total).toBe(1);
  });

  it("debounces writes until five seconds after the last change", async () => {
    store.addPreparedBatch([item("a")]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fs.existsSync(path.join(dir, "memory-store.json"))).toBe(false);
    store.addPreparedBatch([item("b")]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fs.existsSync(path.join(dir, "memory-store.json"))).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await store.flush();
    expect(new JsonVectorStore(dir).stats.total).toBe(2);
  });

  it("creates and reloads provider metadata on unique insertion", async () => {
    const p = { ...provider(), cacheIdentity: { provider: "cloud", model: "fixture-model", dimensions: 2 } };
    await store.addUnique("same", "user_memory", p);
    await store.addUnique("same", "user_memory", p);
    expect(store.stats.total).toBe(2);
    expect(store.getIndexMeta()).toEqual({ provider: "cloud", model: "fixture-model", dimensions: 2, cacheIdentity: JSON.stringify(p.cacheIdentity) });
    await store.flush();
    expect(new JsonVectorStore(dir).getIndexMeta()).toEqual(store.getIndexMeta());
  });

  it("deduplicates only within the requested source and caps recall weight", async () => {
    const p = provider();
    const a = await store.add("a", "user_memory", p);
    const b = await store.add("b", "worldbook", p);
    a.weight = 4.99;
    const duplicate = await store.add("c", "user_memory", p);
    expect(duplicate.id).toBe(a.id);
    expect(duplicate.text).toBe("a");
    expect(duplicate.weight).toBe(5);
    expect(b.id).not.toBe(a.id);
    expect(store.stats.total).toBe(2);
  });

  it("ranks weighted time-decayed scores and updates only selected recalls", async () => {
    const [old, fresh, low] = store.addPreparedBatch([item("old"), item("fresh"), item("low", { embedding: [0.3, 0] })]);
    old.lastRecalledAt -= 24 * 60 * 60 * 1000;
    const result = await store.search("query", undefined, provider(), 2, 0.3);
    expect(result.map(r => r.entry.id)).toEqual([fresh.id, old.id]);
    expect(result.map(r => r.score)).toEqual([1, 0.95]);
    expect(old.weight).toBe(1.05); expect(fresh.weight).toBe(1.05);
    expect(old.lastRecalledAt).toBe(Date.now()); expect(low.weight).toBe(1);
    expect((await store.search("query", undefined, provider(), 5, 0.3)).map(r => r.entry.id)).toContain(low.id);
  });

  it("intersects source, import and allowed-entry filters including explicit empty allowlist", async () => {
    const [a, b, c] = store.addPreparedBatch([item("a"), item("b", { metadata: { importId: "two" } }), item("c", { source: "worldbook" })]);
    expect((await store.search("q", "imported_doc", provider(), 5, 0, { importIds: ["one"], allowedEntryIds: [a.id, b.id, c.id] })).map(r => r.entry.id)).toEqual([a.id]);
    expect(await store.search("q", undefined, provider(), 5, 0, { allowedEntryIds: [] })).toEqual([]);
    expect((await store.search("q", undefined, provider(), 0)).length).toBe(0);
  });

  it("uses the default provider and returns no results if unavailable", async () => {
    store.addPreparedBatch([item("a")]);
    expect(await store.search("q")).toEqual([]);
    vi.mocked(getEmbeddingProvider).mockReturnValue(provider());
    expect(await store.search("q")).toHaveLength(1);
  });

  it("migrates legacy vector dimensions and rejects incompatible providers with exact messages", async () => {
    store.addPreparedBatch([item("a")]);
    const p = { ...provider(), declaredDimensions: 3 };
    await expect(store.search("q", undefined, p)).rejects.toThrow(new Error("[RAG] Index dimension mismatch: existing index has 2-dim vectors, but provider declares 3-dim. Rebuild the index first."));
    await store.search("q", undefined, provider());
    expect(store.getIndexMeta()).toEqual({ provider: "fixture", model: "fixture", dimensions: 2, cacheIdentity: "fixture" });
    await expect(store.addUnique("b", "worldbook", p)).rejects.toThrow(new Error("[RAG] Index dimension mismatch: index was built with 2-dim (model: fixture), but current provider declares 3-dim. Rebuild the index or switch back to the original model."));
  });

  it("accepts a provider whose dimensions are resolved during its first call", async () => {
    await store.addUnique("a", "worldbook", { ...provider(), declaredDimensions: undefined });
    expect(store.getIndexMeta()?.dimensions).toBe(2);
  });

  it("batches more than sixteen items in order without deduplicating", async () => {
    const p = provider();
    const inputs = Array.from({ length: 17 }, (_, i) => ({ text: String(i), source: "imported_doc" }));
    const entries = await store.addBatch(inputs, p);
    expect(entries.map(e => e.text)).toEqual(inputs.map(e => e.text));
    expect(vi.mocked(p.embedBatch).mock.calls.map(([texts]) => texts.length)).toEqual([16, 1]);
    expect(await store.addBatch([], p)).toEqual([]);
  });

  it.each(["before", "after"])("cancels %s embedding without appending the batch", async phase => {
    const p = provider(); let cancelled = phase === "before";
    vi.mocked(p.embedBatch).mockImplementation(async () => { cancelled = true; return [[1, 0]]; });
    await expect(store.addBatch([{ text: "a", source: "imported_doc" }], p, { isCancelled: () => cancelled })).rejects.toThrow(new Error("cancelled"));
    expect(store.stats.total).toBe(0);
    expect(p.embedBatch).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
  });

  it("prunes strictly below the threshold and deletes IDs with optional source restrictions", () => {
    const [a, b, c] = store.addPreparedBatch([item("a"), item("b"), item("c", { source: "worldbook" })]);
    a.weight = 0.09; b.weight = 0.1;
    expect(store.prune()).toBe(1);
    expect(store.deleteEntriesByIds([])).toBe(0);
    expect(store.deleteEntriesByIds([b.id, c.id], "imported_doc")).toBe(1);
    expect(store.deleteEntriesByIds([c.id, c.id])).toBe(1);
    expect(store.stats.total).toBe(0);
  });

  it("deletes imports by exact ID and falls back to filename only for legacy entries", () => {
    store.addPreparedBatch([item("exact"), item("other", { metadata: { importId: "two", fileName: "a.md" } }), item("legacy", { metadata: { fileName: "a.md" } }), item("memory", { source: "user_memory" })]);
    expect(store.hasImportedDocumentChunks("one")).toBe(true);
    expect(store.deleteImportedDoc("one", "a.md")).toBe(2);
    expect(store.hasImportedDocumentChunks("one")).toBe(false);
    expect(store.hasImportedDocumentChunks("two")).toBe(true);
    expect(store.deleteImportedDoc("missing")).toBe(0);
    expect(store.stats).toEqual({ total: 2, sources: { imported_doc: 1, user_memory: 1 } });
  });

  it("clears pending data and metadata in memory for a rebuild", async () => {
    await store.addUnique("a", "worldbook", provider());
    store.clearForRebuild();
    await vi.advanceTimersByTimeAsync(5000); await store.flush();
    expect(store.stats.total).toBe(0); expect(store.getIndexMeta()).toBeNull();
    expect(fs.readFileSync(path.join(dir, "memory-store.json"), "utf8")).toBe("[]");
  });

  it("keeps dirty data available for retry after failed asynchronous or synchronous saves", async () => {
    store.addPreparedBatch([item("a")]);
    const write = vi.spyOn(fs.promises, "writeFile").mockRejectedValueOnce(new Error("disk full"));
    await store.flush();
    expect(store.stats.total).toBe(1);
    write.mockRestore();
    const sync = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw new Error("disk full"); });
    store.flushSync(); expect(sync).toHaveBeenCalledOnce(); sync.mockRestore();
    await store.flush();
    expect(new JsonVectorStore(dir).stats.total).toBe(1);
  });

  it("limits default searches to five entries without recalling the remainder", async () => {
    const entries = store.addPreparedBatch(Array.from({ length: 6 }, (_, i) => item(String(i))));
    const result = await store.search("query", undefined, provider());
    expect(result.map(r => r.entry.id)).toEqual(entries.slice(0, 5).map(e => e.id));
    expect(entries[5].weight).toBe(1);
  });

  it("invalidates an asynchronous save that is overtaken by a rebuild", async () => {
    store.addPreparedBatch([item("old")]);
    const original = fs.promises.writeFile.bind(fs.promises);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(fs.promises, "writeFile").mockImplementationOnce(async (...args: Parameters<typeof fs.promises.writeFile>) => {
      entered(); await gate; return original(...args);
    });
    const flush = store.flush(); await writing;
    store.clearForRebuild(); release(); await flush;
    expect(new JsonVectorStore(dir).stats.total).toBe(0);
    expect(fs.readFileSync(path.join(dir, "memory-store.json"), "utf8")).toBe("[]");
  });
});
