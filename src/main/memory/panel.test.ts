import { afterEach, beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ existsSync: vi.fn(), readFileSync: vi.fn(), getL0: vi.fn(), getL1: vi.fn(), getAllL2: vi.fn(), getReflectionLogs: vi.fn() }));
vi.mock("fs", () => ({ existsSync: deps.existsSync, readFileSync: deps.readFileSync }));
vi.mock("../settings-store", () => ({ getRagStorePath: () => "rag.json" }));
vi.mock("./memory-store", () => ({ memoryStore: deps }));
import { loadMemoryPanelData, loadImportedDocumentPanelData } from "./panel";
beforeEach(() => { vi.resetAllMocks(); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());
it("returns an empty document list for an absent store without accessing personal memory", async () => {
  expect(await loadImportedDocumentPanelData()).toEqual({ importedDocs: [] });
  expect(deps.readFileSync).not.toHaveBeenCalled(); expect(deps.getL0).not.toHaveBeenCalled();
});
it.each(["{bad", "{}", "null"])("contains malformed store %s", async (raw) => {
  deps.existsSync.mockReturnValue(true); deps.readFileSync.mockReturnValue(raw);
  expect(await loadImportedDocumentPanelData()).toEqual({ importedDocs: [] });
});
it("groups imports by ID or legacy filename, counts chunks, and sorts newest first", async () => {
  deps.existsSync.mockReturnValue(true);
  deps.readFileSync.mockReturnValue(JSON.stringify([
    { source: "user_memory", createdAt: 99 },
    { source: "imported_doc", metadata: { importId: "a", fileName: "same" }, createdAt: 1 },
    { source: "imported_doc", metadata: { importId: "a", fileName: "same" }, createdAt: 3 },
    { source: "imported_doc", metadata: { importId: "b", fileName: "same" }, createdAt: 4 },
    { source: "imported_doc", metadata: { fileName: "legacy" }, createdAt: 2 },
    { source: "imported_doc", metadata: { fileName: "legacy" } }, { source: "imported_doc" },
  ]));
  expect((await loadImportedDocumentPanelData()).importedDocs).toEqual([
    { importId: "b", fileName: "same", chunkCount: 1, lastImportedAt: 4 },
    { importId: "a", fileName: "same", chunkCount: 2, lastImportedAt: 3 },
    { importId: null, fileName: "legacy", chunkCount: 2, lastImportedAt: 2 },
    { importId: null, fileName: "未命名文档", chunkCount: 1, lastImportedAt: 0 },
  ]);
});
it("returns profiles and descending L2/reflections with labels and optional details", async () => {
  deps.getL0.mockResolvedValue({ preferredName: "N" }); deps.getL1.mockResolvedValue({ recentGoals: "G" });
  deps.getAllL2.mockResolvedValue([{ id: "old", createdAt: 1 }, { id: "new", createdAt: 2 }]);
  const logs = ["compression", "l0_update", "l1_update", "other"].map((type, i) => ({ id: String(i), type, createdAt: i, summary: "s", details: i ? "d" : "" }));
  deps.getReflectionLogs.mockResolvedValue(logs);
  const result = await loadMemoryPanelData();
  expect(result.l0).toEqual({ preferredName: "N" }); expect(result.l1).toEqual({ recentGoals: "G" });
  expect(result.l2.map((x: any) => x.id)).toEqual(["new", "old"]);
  expect(result.reflections).toEqual([3, 2, 1, 0].map(i => ({ id: String(i), title: ["片段压缩", "画像更新", "近况更新", "other"][i], body: i ? "s\nd" : "s", meta: new Date(i).toLocaleString() })));
  expect(logs.map(x => x.id)).toEqual(["0", "1", "2", "3"]);
});
it("propagates personal memory read errors", async () => {
  const error = new Error("store unavailable"); deps.getL0.mockRejectedValue(error);
  await expect(loadMemoryPanelData()).rejects.toBe(error);
});
