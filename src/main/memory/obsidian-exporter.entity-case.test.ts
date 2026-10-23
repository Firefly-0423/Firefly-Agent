import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({ app: { getPath: () => sandbox.userData } }));

type GraphEntity = { name: string; aliases: string[] };

function seedGraph(entities: GraphEntity[]): void {
  fs.mkdirSync(sandbox.userData, { recursive: true });
  const nodes = entities.map((entity, index) => ({
    id: `ent_${index}`,
    name: entity.name,
    type: "person",
    aliases: entity.aliases,
    mentionCount: 1,
    firstMentionedAt: 1000,
    lastMentionedAt: 2000,
  }));
  fs.writeFileSync(path.join(sandbox.userData, "entity-graph.json"), JSON.stringify({ entities: nodes, relations: [] }, null, 2), "utf8");
}

function readExported(root: string, folder: string, file: string): string {
  return fs.readFileSync(path.join(root, folder, file), "utf8");
}

describe("Obsidian export links entities regardless of letter case", () => {
  let vault: string;

  beforeEach(() => {
    sandbox.userData = fs.mkdtempSync(path.join(os.tmpdir(), "exporter-case-data-"));
    vault = fs.mkdtempSync(path.join(os.tmpdir(), "exporter-case-vault-"));
    vi.resetModules();
  });

  // The exporter must be imported before memories are added (module state is reset per test).
  async function exporter() {
    return (await import("./obsidian-exporter")).exportMemoryToObsidianVault;
  }

  async function remember(content: string, ragId: string) {
    const { memoryStore } = await import("./memory-store");
    return memoryStore.addL2Memory({ content, triggerText: content, sourceConversationId: "conv", ragId, isPinned: false });
  }

  it("links a memory whose text differs in case from the entity name, in both directions", async () => {
    seedGraph([{ name: "Alice", aliases: [] }]);
    const exportVault = await exporter();
    const memory = await remember("the user went hiking with alice last week", "rag_case");

    await exportVault(vault);

    const note = readExported(vault, "记忆", `${memory.id}.md`);
    expect(note).toContain("提及实体：");
    expect(note).toContain("[[Alice]]");
    expect(note).toContain("hiking with alice last week");
    const entityNote = readExported(vault, "实体", "Alice.md");
    expect(entityNote).toContain(`[[${memory.id}]]`);
    expect(entityNote).toContain("出现于");
  });

  it("matches an alias in another case and links to the primary entity file", async () => {
    seedGraph([{ name: "Robert", aliases: ["Bobby"] }]);
    const exportVault = await exporter();
    const memory = await remember("Met BOBBY at the climbing gym", "rag_alias");

    await exportVault(vault);

    const note = readExported(vault, "记忆", `${memory.id}.md`);
    expect(note).toContain("[[Robert]]");
    expect(note).not.toContain("[[Bobby]]");
    expect(readExported(vault, "实体", "Robert.md")).toContain(`[[${memory.id}]]`);
  });

  it("does not link a memory that never mentions the entity", async () => {
    seedGraph([{ name: "Alice", aliases: ["Ally"] }]);
    const exportVault = await exporter();
    const memory = await remember("the user likes running in the morning", "rag_none");

    await exportVault(vault);

    const note = readExported(vault, "记忆", `${memory.id}.md`);
    expect(note).not.toContain("提及实体：");
    expect(note).not.toContain("[[Alice]]");
    expect(readExported(vault, "实体", "Alice.md")).not.toContain(`[[${memory.id}]]`);
  });

  it("does not link short Latin names that only occur inside other words", async () => {
    seedGraph([{ name: "IT", aliases: ["Al"] }]);
    const exportVault = await exporter();
    const inside = await remember("went out with a friend, also stayed late", "rag_inside");
    const whole = await remember("works in it support and met al at lunch", "rag_whole");

    await exportVault(vault);

    expect(readExported(vault, "记忆", `${inside.id}.md`)).not.toContain("[[IT]]");
    expect(readExported(vault, "记忆", `${whole.id}.md`)).toContain("[[IT]]");
    const entityNote = readExported(vault, "实体", "IT.md");
    expect(entityNote).not.toContain(`[[${inside.id}]]`);
    expect(entityNote).toContain(`[[${whole.id}]]`);
  });

  it("keeps substring matching for names without word boundaries, such as Chinese", async () => {
    seedGraph([{ name: "小明", aliases: [] }]);
    const exportVault = await exporter();
    const memory = await remember("今天和小明同学一起去了公园", "rag_zh");

    await exportVault(vault);

    expect(readExported(vault, "记忆", `${memory.id}.md`)).toContain("[[小明]]");
  });

  it("links an exact-case name once even when both the name and an alias match", async () => {
    seedGraph([{ name: "Alice", aliases: ["Ally"] }]);
    const exportVault = await exporter();
    const memory = await remember("Alice (Ally) joined the book club", "rag_exact");

    await exportVault(vault);

    expect(readExported(vault, "记忆", `${memory.id}.md`).match(/\[\[Alice\]\]/g)).toHaveLength(1);
    expect(readExported(vault, "实体", "Alice.md").split(`[[${memory.id}]]`)).toHaveLength(2);
  });
});
