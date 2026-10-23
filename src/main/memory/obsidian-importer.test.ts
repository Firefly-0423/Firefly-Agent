import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const profile = vi.hoisted(() => ({ root: "" }));
const vectors = vi.hoisted(() => ({
  add: vi.fn(async (_text: string, id: string) => `vector:replacement:${id}`), remove: vi.fn(() => 1),
}));
vi.mock("electron", () => ({ app: { getPath: () => profile.root } }));
vi.mock("../rag/index", () => ({ addL2MemoryVector: vectors.add, deleteUserMemoryVectors: vectors.remove }));
let vault: string;
beforeEach(async () => {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  profile.root = mkdtempSync(join(tmpdir(), "ff-vault-import-profile-"));
  vault = mkdtempSync(join(tmpdir(), "ff-vault-import-notes-"));
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(async () => {
  (await import("./obsidian-importer"))._resetForTest();
  await new Promise(resolve => setImmediate(resolve));
  rmSync(profile.root, { force: true, recursive: true });
  rmSync(vault, { force: true, recursive: true });
});
const note = (id: string, body: string) => `---\nid: ${id}\ntype: 片段\n---\n\n# Garden note\n\n${body}\n`;
async function seeded() {
  const { memoryStore: store } = await import("./memory-store");
  const entry = await store.addL2Memory({ content: "Plants need morning light", triggerText: "light", sourceConversationId: "garden-session",
    ragId: "vector:previous", isPinned: false });
  return { store, entry };
}
describe("vault markdown as an editable memory document", () => {
  it.each([
    [note("memory:plain", "Plant mint") + "\n## 关联\n\n- [[Gardener]]\n", { id: "memory:plain", content: "Plant mint" }],
    [note('"memory:quoted"', "Water slowly\nCheck soil"), { id: "memory:quoted", content: "Water slowly\nCheck soil" }],
    [note("memory:sections", "A line with ## Notes\nRetain this line") + "\n## 关联\n- ignored",
      { id: "memory:sections", content: "A line with ## Notes\nRetain this line" }],
    ["# Garden\n\nNo metadata", { id: null, content: null }],
    ["---\ntype: 片段\n---\n# Garden\n\nNo identifier", { id: null, content: null }],
  ])("parses document %s", async (markdown, expected) => {
    const { parseL2Markdown } = await import("./obsidian-importer");
    expect(parseL2Markdown(markdown as string)).toEqual(expected);
  });
});
it("imports edited exported notes and replaces their vectors", async () => {
  const { store, entry } = await seeded();
  const { exportMemoryToObsidianVault } = await import("./obsidian-exporter");
  const { importL2File } = await import("./obsidian-importer");
  await exportMemoryToObsidianVault(vault);
  const target = join(vault, "记忆", `${entry.id}.md`);
  expect(existsSync(target)).toBe(true);
  writeFileSync(target, note(entry.id, "Plants now grow in the shade"));
  expect(await importL2File(target)).toEqual({ id: entry.id, ok: true, changed: true });
  const updated = (await store.getAllL2()).find(item => item.id === entry.id)!;
  expect(updated.content).toBe("Plants now grow in the shade");
  expect(updated.syncStatus).toBe("synced");
  expect(updated.ragId).toBe(`vector:replacement:${entry.id}`);
  expect(vectors.add).toHaveBeenCalledWith("Plants now grow in the shade", entry.id, expect.any(Object));
  expect(vectors.remove).toHaveBeenCalledWith(["vector:previous"]);
});
it("leaves identical exported content untouched", async () => {
  const { store, entry } = await seeded();
  await (await import("./obsidian-exporter")).exportMemoryToObsidianVault(vault);
  const target = join(vault, "记忆", `${entry.id}.md`);
  const original = readFileSync(target, "utf8");
  expect(await (await import("./obsidian-importer")).importL2File(target)).toEqual({ id: entry.id, ok: true, changed: false });
  expect((await store.getAllL2()).find(item => item.id === entry.id)!.content).toBe("Plants need morning light");
  expect(readFileSync(target, "utf8")).toBe(original);
});
it("returns a not-found result for a syntactically valid but unknown id", async () => {
  const { importL2Markdown } = await import("./obsidian-importer");
  expect(await importL2Markdown(note("memory:unregistered", "Unknown plant")))
    .toEqual({ id: "memory:unregistered", ok: false, reason: "not-found", changed: false });
});
it("updates content and keywords while preserving recall and identity fields", async () => {
  const { store, entry } = await seeded();
  const before = structuredClone(entry);
  await store.updateL2Content(entry.id, "蕨根与土壤");
  const updated = (await store.getAllL2()).find(item => item.id === entry.id)!;
  expect(updated.content).toBe("蕨根与土壤");
  expect(updated.syncStatus).toBe("pending_sync");
  expect(updated.keywords).not.toEqual(before.keywords);
  expect(updated.keywords).toEqual(expect.arrayContaining(["蕨", "根", "土", "壤"]));
  for (const field of ["status", "weight", "createdAt", "accessCount", "ragId"] as const) expect(updated[field]).toBe(before[field]);
});
it("keeps edited content and the previous vector id when embedding fails", async () => {
  const { store, entry } = await seeded();
  vectors.add.mockRejectedValueOnce(new Error("vector server offline"));
  const { importL2Markdown } = await import("./obsidian-importer");
  expect((await importL2Markdown(note(entry.id, "Shade-loving plants"))).changed).toBe(true);
  expect((await store.getAllL2()).find(item => item.id === entry.id)).toMatchObject({
    content: "Shade-loving plants", syncStatus: "sync_failed", ragId: "vector:previous",
  });
  expect(vectors.remove).not.toHaveBeenCalled();
});
it("keeps the replacement vector active even if deleting the previous vector fails", async () => {
  const { store, entry } = await seeded();
  vectors.remove.mockImplementationOnce(() => { throw new Error("vector removal offline"); });
  const { importL2Markdown } = await import("./obsidian-importer");
  expect((await importL2Markdown(note(entry.id, "Shade-loving plants"))).changed).toBe(true);
  expect((await store.getAllL2()).find(item => item.id === entry.id)).toMatchObject({
    syncStatus: "synced", ragId: `vector:replacement:${entry.id}`,
  });
});
it("releases the import guard before invoking the embedding provider", async () => {
  const { entry } = await seeded();
  const { isImportingMemory } = await import("./obsidian-sync-flag");
  vectors.add.mockImplementationOnce(async () => { expect(isImportingMemory()).toBe(false); return "vector:guard-probe"; });
  await (await import("./obsidian-importer")).importL2Markdown(note(entry.id, "New garden plan"));
  expect(vectors.add).toHaveBeenCalledTimes(1);
});
