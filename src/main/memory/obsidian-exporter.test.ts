import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const profile = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: { getPath: () => profile.root } }));
let vault: string;
beforeEach(async () => {
  await new Promise(resolve => setImmediate(resolve));
  profile.root = mkdtempSync(join(tmpdir(), "ff-export-profile-"));
  vault = mkdtempSync(join(tmpdir(), "ff-export-vault-"));
  vi.resetModules();
});
afterEach(async () => {
  await new Promise(resolve => setImmediate(resolve));
  rmSync(profile.root, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
});
async function workspace() {
  const { memoryStore: store } = await import("./memory-store");
  const { exportMemoryToObsidianVault } = await import("./obsidian-exporter");
  return { store, exportVault: () => exportMemoryToObsidianVault(vault),
    add: (content: string, ragId = "vector:garden") => store.addL2Memory({ content, ragId, triggerText: "garden source",
      sourceConversationId: "garden-session", isPinned: false }) };
}
const read = (relative: string) => readFileSync(join(vault, relative), "utf8");
it("exports profile, current context and individual memories with their observable metadata", async () => {
  const h = await workspace();
  await h.store.updateL0({ preferredName: "River", occupation: "Botanist", longTermInterests: "Orchids",
    language: "English", permanentNote: "Keeps a greenhouse" });
  await h.store.updateL1({ recentGoals: "Grow basil", recentPreferences: "Quiet mornings", currentProject: "Greenhouse" });
  const entry = await h.add("The user keeps seedlings");
  const result = await h.exportVault();
  expect(result.ok).toBe(true);
  expect(result.fileCount).toBeGreaterThan(0);
  for (const fragment of ["preferredName: River", "occupation: Botanist", "# 用户画像", "Orchids"]) expect(read("画像.md")).toContain(fragment);
  for (const fragment of ["type: 近况", "Grow basil", "Greenhouse"]) expect(read("近况.md")).toContain(fragment);
  const filename = join("记忆", `${entry.id}.md`);
  expect(existsSync(join(vault, filename))).toBe(true);
  for (const fragment of [`id: ${entry.id}`, "type: 片段", "status: 活跃", "sourceConversationId: garden-session",
    "ragId: vector:garden", "The user keeps seedlings", "tags: [记忆, 片段, active]"]) {
    // Colon-containing identifiers are quoted in YAML.
    expect(read(filename)).toContain(fragment === "ragId: vector:garden" ? 'ragId: "vector:garden"' : fragment);
  }
});
it("links summaries, conflicting vectors and replacement memories to their exported note names", async () => {
  const h = await workspace();
  const first = await h.add("Plants prefer sun", "vector-first"), second = await h.add("Plants prefer shade", "vector-second");
  const summary = await h.add("Light preferences evolved", "vector-summary");
  const state = await h.store.load();
  Object.assign(state.l2.find(item => item.id === summary.id)!, { subEntryIds: [first.id, second.id], isSummary: true });
  Object.assign(state.l2.find(item => item.id === first.id)!, { conflictWith: ["vector-second"], supersededBy: summary.id });
  await h.store.save(state);
  await h.exportVault();
  const summarized = read(join("记忆", `${summary.id}.md`)), original = read(join("记忆", `${first.id}.md`));
  for (const fragment of [`[[${first.id}]]`, `[[${second.id}]]`, "压缩自：", "isSummary: true"]) expect(summarized).toContain(fragment);
  for (const fragment of [`[[${second.id}]]`, `[[${summary.id}]]`, "冲突：", "被替代为："]) expect(original).toContain(fragment);
});
it("exports entity links in both directions", async () => {
  writeFileSync(join(profile.root, "entity-graph.json"), JSON.stringify({ entities: [{ id: "entity:river", name: "River",
    aliases: ["Riv"], type: "person", mentionCount: 3, firstMentionedAt: 4000, lastMentionedAt: 9000 }], relations: [] }));
  const h = await workspace(), entry = await h.add("Walked through the greenhouse with River");
  await h.exportVault();
  for (const fragment of ["[[River]]", "提及实体："]) expect(read(join("记忆", `${entry.id}.md`))).toContain(fragment);
  for (const fragment of ["name: River", "type: 人物", `[[${entry.id}]]`, "出现于"]) expect(read(join("实体", "River.md"))).toContain(fragment);
});
it("uses a slug filename while retaining ids and omitting absent quote metadata", async () => {
  const h = await workspace(), original = await h.add("Seed notes"), summary = await h.add("Seed notes summary");
  const state = await h.store.load();
  Object.assign(state.l2.find(item => item.id === summary.id)!, { slug: "seed-summary", subEntryIds: [original.id], isSummary: true });
  await h.store.save(state);
  await h.exportVault();
  expect(existsSync(join(vault, "记忆", "seed-summary.md"))).toBe(true);
  expect(existsSync(join(vault, "记忆", `${summary.id}.md`))).toBe(false);
  expect(existsSync(join(vault, "记忆", `${original.id}.md`))).toBe(true);
  const document = read(join("记忆", "seed-summary.md"));
  for (const fragment of [`id: ${summary.id}`, "slug: seed-summary", `[[${original.id}]]`, "压缩自："]) expect(document).toContain(fragment);
  expect(document).not.toMatch(/^sourceQuote:/m);
  expect(read(join("记忆", `${original.id}.md`))).not.toMatch(/^slug:/m);
});
it("deduplicates three equal slugs in both filenames and links while retaining the original slug field", async () => {
  const h = await workspace(), entries = [];
  for (const content of ["First mint note", "Second mint note", "Third mint note"]) entries.push(await h.add(content));
  const state = await h.store.load();
  for (const entry of state.l2) entry.slug = "mint-notes";
  state.l2[2].subEntryIds = [entries[0].id, entries[1].id];
  await h.store.save(state);
  await h.exportVault();
  for (const filename of ["mint-notes.md", "mint-notes-2.md", "mint-notes-3.md"]) {
    expect(existsSync(join(vault, "记忆", filename))).toBe(true);
    expect(read(join("记忆", filename))).toContain("slug: mint-notes");
  }
  const third = read(join("记忆", "mint-notes-3.md"));
  expect(third).toContain("[[mint-notes]]");
  expect(third).toContain("[[mint-notes-2]]");
  expect(third).not.toMatch(/\[\[mint-notes\]\].*\[\[mint-notes\]\]/);
});
it("includes source quotes in the frontmatter of slugged memories", async () => {
  const h = await workspace(), entry = await h.add("Uses a greenhouse sensor");
  const state = await h.store.load();
  Object.assign(state.l2.find(item => item.id === entry.id)!, { slug: "sensor-notes", sourceQuote: "My sensor reports 18.5 degrees, updated daily" });
  await h.store.save(state);
  await h.exportVault();
  expect(existsSync(join(vault, "记忆", "sensor-notes.md"))).toBe(true);
  for (const fragment of [`id: ${entry.id}`, "slug: sensor-notes", "sourceQuote: My sensor reports 18.5 degrees, updated daily"])
    expect(read(join("记忆", "sensor-notes.md"))).toContain(fragment);
});
it("re-exports the same file set, removes stale generated notes, and preserves personal notes", async () => {
  const h = await workspace(), entry = await h.add("Temporary garden note");
  writeFileSync(join(vault, "personal.md"), "# Private garden\n\nKeep this note");
  const first = await h.exportVault();
  expect(first.ok).toBe(true);
  const filenames = readdirSync(vault, { recursive: true }).sort();
  const second = await h.exportVault();
  expect(second.ok).toBe(true);
  expect(second.fileCount).toBe(first.fileCount);
  expect(readdirSync(vault, { recursive: true }).sort()).toEqual(filenames);
  const generated = join(vault, "记忆", `${entry.id}.md`);
  expect(existsSync(generated)).toBe(true);
  await h.store.deleteL2(entry.id);
  await h.exportVault();
  expect(existsSync(generated)).toBe(false);
  expect(existsSync(join(vault, "personal.md"))).toBe(true);
  expect(read("personal.md")).toContain("Keep this note");
});
