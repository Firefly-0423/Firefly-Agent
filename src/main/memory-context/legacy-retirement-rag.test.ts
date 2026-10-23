import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const mocks = vi.hoisted(() => ({ dir: "", feed: vi.fn(), dims: 2, embeds: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => mocks.dir, getAppPath: () => mocks.dir } }));
vi.mock("../memory/entity-graph", () => ({ feedEntityNamesToJieba: mocks.feed }));
vi.mock("./../rag/embedding", async (original) => ({
  ...(await original<typeof import("../rag/embedding")>()),
  getEmbeddingProvider: () => ({ name: "deterministic", dims: mocks.dims,
    embed: async (text: string) => { mocks.embeds(text); return Array.from({ length: mocks.dims }, (_, i) => i === 0 ? 1 : 0); },
    embedBatch: async (texts: string[]) => texts.map(() => Array.from({ length: mocks.dims }, (_, i) => i === 0 ? 1 : 0)),
  }),
  switchEmbeddingModel: vi.fn(),
}));
vi.mock("../rag/reranker", () => ({ getReranker: () => null }));
vi.mock("../rag/worldbook", () => ({ WorldbookManager: class {
  async loadFromDirectory() {} getPermanentEntries() { return ["worldbook remains"]; } getActiveEntries() { return ["worldbook remains"]; }
  updateActivation() {} getCascadeEntries() { return []; } getEntries() { return []; }
} }));
import * as rag from "../rag";
let file: string;
let personal: unknown[];
beforeEach(() => {
  vi.clearAllMocks(); mocks.dims = 2;
  mocks.dir = fs.mkdtempSync(path.join(os.tmpdir(), "retired-rag-"));
  file = path.join(mocks.dir, "rag-data", "memory-store.json"); fs.mkdirSync(path.dirname(file));
  const entry = (id: string, source: string) => ({ id, source, text: "matching knowledge", embedding: [1, 0], weight: 1, createdAt: Date.now(), lastRecalledAt: Date.now(), metadata: { l2Id: "legacy-l2", importId: id, fileName: id } });
  personal = [entry("old-memory", "user_memory"), entry("old-history", "chat_history")];
  fs.writeFileSync(file, JSON.stringify([...personal, entry("document", "imported_doc"), entry("knowledge", "work_knowledge")]));
});
afterEach(async () => { await rag.flushRAGStore(); rag.resetRAG(); fs.rmSync(mocks.dir, { recursive: true, force: true }); });
async function start() { await rag.initRAG("auto", undefined, undefined, undefined, undefined, { personalMemoryMode: "smh" }); }
function readPersonal() { return JSON.parse(fs.readFileSync(file, "utf8")).filter((entry: any) => ["user_memory", "chat_history"].includes(entry.source)); }

describe("SMH mixed RAG retirement boundary", () => {
  it("does not initialize personal entity dictionaries and rejects legacy APIs before reads, embedding or writes", async () => {
    const before = fs.readFileSync(file, "utf8");
    await start();
    expect(mocks.feed).not.toHaveBeenCalled();
    expect(rag.isUserMemoryVectorStoreReady()).toBe(false);
    for (const source of ["user_memory", "chat_history"]) {
      await expect(rag.addMemory("private", source)).rejects.toThrow("MEMORY_LEGACY_RETIRED");
      await expect(rag.searchMemoryEntries("private", source)).rejects.toThrow("MEMORY_LEGACY_RETIRED");
      expect(() => rag.getEntriesBySource(source)).toThrow("MEMORY_LEGACY_RETIRED");
    }
    await expect(rag.addMemory("matching knowledge", "")).rejects.toThrow("MEMORY_LEGACY_RETIRED");
    await expect(rag.addL2MemoryVector("private", "old-id")).rejects.toThrow("MEMORY_LEGACY_RETIRED");
    await expect(rag.searchHistoryEntries("private")).rejects.toThrow("MEMORY_LEGACY_RETIRED");
    expect(() => rag.deleteUserMemoryVectors(["old-memory"])).toThrow("MEMORY_LEGACY_RETIRED");
    expect(mocks.embeds).not.toHaveBeenCalled();
    await rag.flushRAGStore(); rag.flushRAGStoreSync();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
  it("restricts unscoped searches before scoring and retains personal records unchanged through document writes and flush", async () => {
    await start();
    expect((await rag.searchMemoryEntries("matching", undefined, 10)).map((entry) => entry.id).sort()).toEqual(["document", "knowledge"]);
    expect(await rag.searchMemory("matching", "imported_doc")).toEqual(["matching knowledge"]);
    expect(rag.getPermanentWorldbookEntries()).toEqual(["worldbook remains"]);
    const imported = await rag.importDocumentForTurn("new matching knowledge", "new.md");
    expect(imported.chunkCount).toBeGreaterThan(0);
    expect(rag.hasImportedDocumentChunks(imported.importId)).toBe(true);
    expect(rag.deleteImportedDoc("document")).toBe(1);
    await rag.flushRAGStore();
    expect(readPersonal()).toEqual(personal);
  });
  it("does not clear or migrate retired personal records when embedding dimensions change", async () => {
    await start(); mocks.dims = 3;
    const before = fs.readFileSync(file, "utf8");
    expect(await rag.switchEmbeddingModel("bgem3")).toEqual({ ok: false, clearedEntries: 0, error: "MEMORY_LEGACY_RETIRED" });
    await rag.flushRAGStore();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
