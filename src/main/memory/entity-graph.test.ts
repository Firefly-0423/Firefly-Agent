import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  directory: "",
  words: [] as string[],
  batches: [] as string[][],
  info: vi.fn(),
}));

vi.mock("electron", () => ({ app: { getPath: () => state.directory } }));
vi.mock("../rag/retriever", () => ({
  registerJiebaCustomWord: (word: string) => { state.words.push(word); },
  registerJiebaCustomWords: (words: string[]) => { state.batches.push([...words]); },
}));
vi.mock("../logger", () => ({
  logger: { info: state.info, warn: vi.fn(), error: vi.fn() },
  LogTag: { EntityGraph: "EntityGraph" },
}));

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-entity-graph-"));
  state.directory = root;
  state.words.length = 0;
  state.batches.length = 0;
  state.info.mockClear();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const file = (): string => path.join(root, "entity-graph.json");
const writeGraph = (value: unknown): void => fs.writeFileSync(file(), JSON.stringify(value));
const readGraph = (): { entities: Array<Record<string, unknown>>; relations: Array<Record<string, unknown>> } =>
  JSON.parse(fs.readFileSync(file(), "utf8"));

async function fresh() {
  return import("./entity-graph");
}

function entity(id: string, name: string, type: string, aliases: string[] = [], mentionCount = 1) {
  return {
    id,
    name,
    type,
    aliases,
    mentionCount,
    firstMentionedAt: 1,
    lastMentionedAt: 2,
  };
}

describe("EntityGraph.load and save", () => {
  it("starts empty when the file is missing and caches the empty graph", async () => {
    const { entityGraph } = await fresh();
    expect(entityGraph.load()).toEqual({ entities: [], relations: [] });
    writeGraph({ entities: [entity("e1", "alice", "person")], relations: [] });
    expect(entityGraph.load()).toEqual({ entities: [], relations: [] });
  });

  it("returns an empty graph for corrupt JSON", async () => {
    fs.writeFileSync(file(), "{broken");
    const { entityGraph } = await fresh();
    expect(entityGraph.load()).toEqual({ entities: [], relations: [] });
  });

  it("loads stored entities and relations", async () => {
    const stored = {
      entities: [entity("e1", "alice", "person", ["ally"], 3)],
      relations: [{ id: "r1", sourceId: "e1", targetId: "e2", relation: "likes", confidence: 0.8, strength: 2 }],
    };
    writeGraph(stored);
    const { entityGraph } = await fresh();
    expect(entityGraph.load()).toEqual(stored);
  });

  it("does not write before a graph has been loaded or changed", async () => {
    const { entityGraph } = await fresh();
    entityGraph.save();
    expect(fs.existsSync(file())).toBe(false);
  });

  it("writes the loaded graph as pretty JSON and creates the directory", async () => {
    const nested = path.join(root, "nested", "data");
    state.directory = nested;
    const { entityGraph } = await fresh();
    entityGraph.load();
    entityGraph.save();
    expect(fs.existsSync(path.join(nested, "entity-graph.json"))).toBe(true);
    expect(fs.readFileSync(path.join(nested, "entity-graph.json"), "utf8")).toContain('\n  "entities"');
  });
});

describe("EntityGraph.ingestEntities", () => {
  it("does nothing at all for an empty batch", async () => {
    const { entityGraph } = await fresh();
    entityGraph.ingestEntities([]);
    expect(fs.existsSync(file())).toBe(false);
    expect(state.words).toEqual([]);
  });

  it("ignores blank and one-character names while storing valid entities", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const { entityGraph } = await fresh();
    entityGraph.ingestEntities([
      { name: "", type: "person" },
      { name: "   ", type: "person" },
      { name: " A ", type: "person" },
      { name: " Alice ", type: "person", aliases: [" Al ", "", "Alice", "Allie"] },
    ]);

    const graph = readGraph();
    expect(graph.entities).toHaveLength(1);
    expect(graph.entities[0]).toMatchObject({
      name: "Alice",
      type: "person",
      aliases: ["Al", "Allie"],
      mentionCount: 1,
      firstMentionedAt: 1234,
      lastMentionedAt: 1234,
    });
    expect(graph.relations).toEqual([]);
    expect(graph.entities[0].id).toMatch(/^ent_1234_[a-z0-9]{1,6}$/);
    expect(state.words).toEqual(["Alice"]);
  });

  it.each(["Alice", "AL"])("persists a repeat mention of %s without new aliases", async (name) => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { entityGraph } = await fresh();
    entityGraph.ingestEntities([{ name: "Alice", type: "person", aliases: ["Al"] }]);
    now = 2000;
    entityGraph.ingestEntities([{ name, type: "person", aliases: [" al ", "ALICE"] }]);

    const graph = readGraph();
    expect(graph.entities).toHaveLength(1);
    expect(graph.entities[0]).toMatchObject({
      name: "Alice",
      mentionCount: 2,
      firstMentionedAt: 1000,
      lastMentionedAt: 2000,
      aliases: ["Al"],
    });
  });

  it("matches an existing entity by alias and merges new aliases", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const { entityGraph } = await fresh();
    entityGraph.ingestEntities([{ name: "Alice", type: "person", aliases: ["Al"] }]);
    entityGraph.ingestEntities([{ name: "Al", type: "person", aliases: ["Allie", " Alice "] }]);

    const graph = readGraph();
    expect(graph.entities).toHaveLength(1);
    expect(graph.entities[0]).toMatchObject({ name: "Alice", mentionCount: 2, aliases: ["Al", "Allie"] });
    expect(state.words).toEqual(["Alice", "Allie"]);
  });

  it("treats differently-cased spellings as one entity and keeps the first spelling", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { entityGraph } = await fresh();
    entityGraph.ingestEntities([{ name: "alice", type: "person" }]);
    now = 2000;
    entityGraph.ingestEntities([{ name: " Alice ", type: "person" }]);

    const graph = readGraph();
    expect(graph.entities).toHaveLength(1);
    expect(graph.entities[0]).toMatchObject({
      name: "alice",
      mentionCount: 2,
      firstMentionedAt: 1000,
      lastMentionedAt: 2000,
    });
    expect(state.words).toEqual(["alice"]);
  });

  it("matches an alias case-insensitively and does not duplicate differently-cased aliases", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const { entityGraph } = await fresh();
    entityGraph.ingestEntities([{ name: "Alice", type: "person", aliases: ["Al", "alice"] }]);
    entityGraph.ingestEntities([{ name: "AL", type: "person", aliases: ["al", "ALICE", "Allie", "ALLIE"] }]);

    const graph = readGraph();
    expect(graph.entities).toHaveLength(1);
    expect(graph.entities[0]).toMatchObject({ name: "Alice", mentionCount: 2, aliases: ["Al", "Allie"] });
  });

  it("persists a differently-cased mention that adds no alias", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { entityGraph } = await fresh();
    entityGraph.ingestEntities([{ name: "alice", type: "person" }]);
    now = 2000;
    entityGraph.ingestEntities([{ name: "Alice", type: "person" }]);

    expect(readGraph().entities[0]).toMatchObject({ name: "alice", mentionCount: 2, lastMentionedAt: 2000 });
  });

  it("deduplicates case variants inside one alias list for new and existing entities", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const { entityGraph } = await fresh();
    entityGraph.ingestEntities([{ name: "Alice", type: "person", aliases: ["Allie", "ALLIE", "alice"] }]);
    expect(readGraph().entities[0].aliases).toEqual(["Allie"]);

    entityGraph.ingestEntities([{ name: "Alice", type: "person", aliases: ["Lissa", "LISSA", "allie"] }]);
    expect(readGraph().entities[0].aliases).toEqual(["Allie", "Lissa"]);
  });

  it("keeps clearly different names as separate entities", async () => {
    const { entityGraph } = await fresh();
    entityGraph.ingestEntities([
      { name: "alice", type: "person" },
      { name: "Bob", type: "person" },
      { name: "alicia", type: "person" },
    ]);
    const graph = readGraph();
    expect(graph.entities.map((e) => e.name)).toEqual(["alice", "Bob", "alicia"]);
    expect(graph.entities.every((e) => e.mentionCount === 1)).toBe(true);
  });

  it("keeps relations (stored by id) attached to the entity after a differently-cased mention", async () => {
    writeGraph({
      entities: [entity("e1", "alice", "person"), entity("e2", "shanghai", "place")],
      relations: [{ id: "r1", sourceId: "e1", targetId: "e2", relation: "lives_in", confidence: 1, strength: 1 }],
    });
    const { entityGraph } = await fresh();
    entityGraph.ingestEntities([{ name: "Alice", type: "person" }]);
    expect(entityGraph.search("alice")).toBe(["· alice（人物）（提及2次）", "  → lives_in shanghai"].join("\n"));
  });

  it("does not save when every extracted entity is invalid", async () => {
    const { entityGraph } = await fresh();
    entityGraph.ingestEntities([{ name: "A", type: "person" }, { name: " ", type: "place" }]);
    expect(fs.existsSync(file())).toBe(false);
    expect(state.words).toEqual([]);
  });
});

describe("EntityGraph.search", () => {
  function seed() {
    writeGraph({
      entities: [
        entity("e1", "alice", "person", ["ally"], 3),
        entity("e2", "shanghai", "place", [], 1),
      ],
      relations: [
        { id: "r1", sourceId: "e1", targetId: "e2", relation: "lives_in", confidence: 1, strength: 2 },
        { id: "r2", sourceId: "e2", targetId: "e1", relation: "hosts", confidence: 1, strength: 1 },
      ],
    });
  }

  it("returns an empty string for an empty graph", async () => {
    const { entityGraph } = await fresh();
    expect(entityGraph.search("alice")).toBe("");
  });

  it("returns an empty string when nothing matches", async () => {
    seed();
    const { entityGraph } = await fresh();
    expect(entityGraph.search("nobody")).toBe("");
  });

  it("renders the entity, mention count and both relation directions", async () => {
    seed();
    const { entityGraph } = await fresh();
    expect(entityGraph.search("alice")).toBe([
      "· alice（人物）（提及3次）",
      "  → lives_in shanghai",
      "  ← shanghai hosts",
    ].join("\n"));
  });

  it("lower-cases the query before matching aliases and omits the mention suffix for a single mention", async () => {
    seed();
    const { entityGraph } = await fresh();
    expect(entityGraph.search("ALLY")).toBe([
      "· alice（人物）（提及3次）",
      "  → lives_in shanghai",
      "  ← shanghai hosts",
    ].join("\n"));
    expect(entityGraph.search("shanghai")).toContain("· shanghai（地点）");
    expect(entityGraph.search("shanghai")).not.toContain("提及1次");
  });

  it("matches stored names and aliases with upper-case letters and keeps the stored spelling in the output", async () => {
    writeGraph({ entities: [entity("e1", "Alice", "person", ["Ally"], 2)], relations: [] });
    const { entityGraph } = await fresh();
    const expected = "· Alice（人物）（提及2次）";
    expect(entityGraph.search("alice")).toBe(expected);
    expect(entityGraph.search("ALLY")).toBe(expected);
    expect(entityGraph.search("Alice")).toBe(expected);
    expect(entityGraph.search("nobody")).toBe("");
  });

  it("matches any whitespace-separated query token", async () => {
    seed();
    const { entityGraph } = await fresh();
    const result = entityGraph.search("unknown shanghai");
    expect(result).toContain("· shanghai（地点）");
    expect(result).not.toContain("· alice");
  });

  it("skips relations whose target or source is missing", async () => {
    writeGraph({
      entities: [entity("e1", "alice", "person")],
      relations: [
        { id: "r1", sourceId: "e1", targetId: "gone", relation: "likes", confidence: 1, strength: 1 },
        { id: "r2", sourceId: "gone", targetId: "e1", relation: "knows", confidence: 1, strength: 1 },
      ],
    });
    const { entityGraph } = await fresh();
    expect(entityGraph.search("alice")).toBe("· alice（人物）");
  });
});

describe("reset, name export and jieba feeding", () => {
  it("reset clears the graph and persists the empty state", async () => {
    seedGraph();
    const { entityGraph } = await fresh();
    expect(entityGraph.load().entities).toHaveLength(1);
    entityGraph.reset();
    expect(entityGraph.load()).toEqual({ entities: [], relations: [] });
    expect(readGraph()).toEqual({ entities: [], relations: [] });
  });

  it("getAllEntityNames deduplicates names and aliases and drops short names", async () => {
    writeGraph({
      entities: [
        entity("e1", "A", "person", ["Alice"]),
        entity("e2", "Alice", "person", ["Al"]),
      ],
      relations: [],
    });
    const { getAllEntityNames } = await fresh();
    expect(getAllEntityNames()).toEqual(["Alice", "Al"]);
  });

  it("feeds names to jieba only when the graph has usable names", async () => {
    writeGraph({
      entities: [entity("e1", "Alice", "person", ["Al"]), entity("e2", "Bob", "person")],
      relations: [],
    });
    const { feedEntityNamesToJieba } = await fresh();
    await feedEntityNamesToJieba();
    expect(state.batches).toEqual([["Alice", "Al", "Bob"]]);
    expect(state.info).toHaveBeenCalledWith("EntityGraph", "registered 3 entity names into jieba custom dictionary");
  });

  it("does not register or log when the graph is empty", async () => {
    const { feedEntityNamesToJieba } = await fresh();
    await feedEntityNamesToJieba();
    expect(state.batches).toEqual([]);
    expect(state.info).not.toHaveBeenCalled();
  });
});

function seedGraph(): void {
  writeGraph({ entities: [entity("e1", "alice", "person")], relations: [] });
}
