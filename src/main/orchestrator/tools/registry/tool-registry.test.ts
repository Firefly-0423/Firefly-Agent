import { describe, expect, it, vi } from "vitest";

const searchMemory = vi.hoisted(() => vi.fn());
vi.mock("../../../rag/index", () => ({ searchMemory }));

import {
  ToolRegistry, toolRegistry, controlledInputKind, controlledInputType,
  resolveEffectKind, resolveVerificationPolicy, buildWriteCandidate, formatMemoryOverview,
  type ControlledInputPolicy, type ToolDefinition,
} from "./tool-registry";

function tool(id: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return { id, name: id, description: "fixture", enabled: true,
    inputSchema: { type: "object", properties: {} }, execute: async () => id, ...extra };
}

describe("controlled inputs", () => {
  it.each<ControlledInputPolicy>(["context_ref", "context_ref_array", "tool_result",
    { type: "context_ref", kind: "file" }, { type: "context_ref_array", kind: "image" }, { type: "tool_result" }])(
    "reads policy type and optional kind: %j", policy => {
      expect(controlledInputType(policy)).toBe(typeof policy === "string" ? policy : policy.type);
      expect(controlledInputKind(policy)).toBe(typeof policy === "object" && "kind" in policy ? policy.kind : undefined);
    },
  );
});

describe("ToolRegistry", () => {
  it("starts empty and handles unknown lookups, enable changes and removal", () => {
    const registry = new ToolRegistry();
    expect(registry.getAllTools()).toEqual([]);
    expect(registry.getEnabledTools()).toEqual([]);
    expect(registry.getById("missing")).toBeUndefined();
    registry.setEnabled("missing", true);
    expect(registry.unregister("missing")).toBe(false);
  });
  it("replaces duplicate IDs in insertion order and returns detached lists", async () => {
    const registry = new ToolRegistry();
    registry.register(tool("a")); registry.register(tool("b"));
    registry.register(tool("a", { execute: async () => "replacement" }));
    expect(registry.getAllTools().map(t => t.id)).toEqual(["a", "b"]);
    expect(await registry.getById("a")!.execute({})).toBe("replacement");
    registry.getAllTools().pop();
    expect(registry.getAllTools()).toHaveLength(2);
    expect(registry.unregister("a")).toBe(true);
    expect(registry.unregister("a")).toBe(false);
    expect(registry.getById("a")).toBeUndefined();
  });
  it("excludes disabled and deprecated tools and supports re-enabling", () => {
    const registry = new ToolRegistry();
    registry.register(tool("on")); registry.register(tool("off", { enabled: false }));
    registry.register(tool("old", { deprecated: true }));
    expect(registry.getEnabledTools().map(t => t.id)).toEqual(["on"]);
    registry.setEnabled("on", false); registry.setEnabled("off", true);
    expect(registry.getEnabledTools().map(t => t.id)).toEqual(["off"]);
    expect(registry.getAllTools()).toHaveLength(3);
  });
  it("applies mode overrides before defaults without overriding global disabled/deprecated flags", () => {
    const registry = new ToolRegistry();
    registry.register(tool("all")); registry.register(tool("code", { modes: ["code"] }));
    registry.register(tool("none", { modes: [] })); registry.register(tool("off", { enabled: false }));
    registry.register(tool("old", { deprecated: true }));
    expect(registry.getEnabledToolsForMode("work").map(t => t.id)).toEqual(["all"]);
    expect(registry.getEnabledToolsForMode("code").map(t => t.id)).toEqual(["all", "code"]);
    expect(registry.getEnabledToolsForMode("work", {
      all: { work: false }, code: { work: true }, none: { work: true }, off: { work: true }, old: { work: true },
    }).map(t => t.id)).toEqual(["code", "none"]);
  });
  it.each(["user_memory", "read_memory", "write_memory", "recall_history"])(
    "enforces retirement on already captured %s executors and allows restoring legacy mode", async id => {
      const registry = new ToolRegistry();
      registry.register(tool(id, { execute: async args => String(args.value) }));
      registry.register(tool("ordinary"));
      const captured = registry.getById(id)!;
      expect(await captured.execute({ value: "original" })).toBe("original");
      registry.setPersonalMemoryMode("smh");
      expect(await captured.execute({ value: "ignored" })).toBe("MEMORY_LEGACY_RETIRED");
      expect(registry.getEnabledTools().map(t => t.id)).toEqual(["ordinary"]);
      expect(registry.getEnabledToolsForMode("work", { [id]: { work: true } }).map(t => t.id)).toEqual(["ordinary"]);
      expect(registry.getAllTools()).toHaveLength(2);
      registry.setPersonalMemoryMode("legacy");
      expect(await captured.execute({ value: "restored" })).toBe("restored");
    },
  );
  it("can start with the legacy memory tools retired", async () => {
    const registry = new ToolRegistry({ personalMemoryMode: "smh" });
    registry.register(tool("read_memory"));
    expect(await registry.getById("read_memory")!.execute({})).toBe("MEMORY_LEGACY_RETIRED");
    expect(registry.getEnabledTools()).toEqual([]);
  });
});

describe("effect and verification resolution", () => {
  it("uses conservative defaults for missing tools and metadata", () => {
    for (const definition of [undefined, tool("plain")]) {
      expect(resolveEffectKind(definition, {})).toBe("unknown");
      expect(resolveVerificationPolicy(definition, {})).toBe("none");
    }
  });
  it("uses static metadata and lets argument-dependent resolvers override it", () => {
    const definition = tool("dynamic", { effectKind: "read", verificationPolicy: "artifact" });
    expect(resolveEffectKind(definition, {})).toBe("read");
    expect(resolveVerificationPolicy(definition, {})).toBe("artifact");
    definition.effectResolver = args => args.write ? "mutation" : "verification";
    definition.verificationPolicyResolver = args => args.code ? "code" : "none";
    expect(resolveEffectKind(definition, { write: true })).toBe("mutation");
    expect(resolveEffectKind(definition, {})).toBe("verification");
    expect(resolveVerificationPolicy(definition, { code: true })).toBe("code");
    expect(resolveVerificationPolicy(definition, {})).toBe("none");
  });
  it("propagates resolver failures", () => {
    const fail = () => { throw new Error("classification failed"); };
    const definition = tool("bad", { effectResolver: fail, verificationPolicyResolver: fail });
    expect(() => resolveEffectKind(definition, {})).toThrow(/^classification failed$/);
    expect(() => resolveVerificationPolicy(definition, {})).toThrow(/^classification failed$/);
  });
});

describe("memory helper behavior", () => {
  it("formats fields in their documented order and ignores unknown/blank fields", () => {
    const result = formatMemoryOverview({ language: " zh ", preferredName: " Ada ", occupation: " ", extra: "ignored" },
      { currentProject: " app ", recentGoals: " ship ", recentPreferences: " " }, []);
    expect(result).toBe("== 核心画像（L0）==\n- 称呼: Ada\n- 语言习惯: zh\n\n== 近期状态（L1）==\n- 近期目标: ship\n- 当前项目: app\n\n== 对话记忆（L2，共 0 条，列出最新 0 条）==\n- （空）\n\n带 id 参数可读取单条 L2 全文。");
  });
  it("shows only the latest 50 L2 entries without reordering the input", () => {
    const items = Array.from({ length: 51 }, (_, i) => ({ id: `id-${i}`, title: `title-${i}`, status: "active", createdAt: i * 86_400_000 }));
    const before = items.map(i => i.id);
    const result = formatMemoryOverview({ isPinned: true }, {}, items);
    const entries = result.split("\n").filter(line => line.startsWith("- ["));
    expect(entries).toHaveLength(50);
    expect(entries[0]).toBe("- [id-50] title-50 · active · 1970-02-20");
    expect(entries.at(-1)).toBe("- [id-1] title-1 · active · 1970-01-02");
    expect(result).toContain("共 51 条，列出最新 50 条");
    expect(result).toContain("（画像已被用户锁定，工具写入会被跳过）");
    expect(items.map(i => i.id)).toEqual(before);
  });
  it.each(["L0", "L1", "l2"])("builds trimmed explicit candidates for %s", layer => {
    expect(buildWriteCandidate({ layer, content: " fact ", field: " field ", slug: " title ", sourceQuote: " quote ", triggerText: " original " })).toEqual({
      layer: layer.toUpperCase(), content: "fact", field: "field", slug: layer === "l2" ? "title" : undefined,
      sourceQuote: layer === "l2" ? "quote" : undefined, confidence: 1, certainty: "explicit", attribution: "user_explicit", shouldWrite: true, triggerText: " original ",
    });
  });
  it.each([{ layer: "invalid", content: "fact" }, { layer: "", content: "fact" }, { layer: "L2", content: " \n " }])(
    "refuses invalid candidates %j", input => expect(buildWriteCandidate({ ...input, triggerText: "x" })).toBeNull(),
  );
  it("omits blank optional candidate fields", () => {
    expect(buildWriteCandidate({ layer: "L2", content: "fact", field: " ", slug: "", sourceQuote: " ", triggerText: "x" }))
      .toMatchObject({ field: undefined, slug: undefined, sourceQuote: undefined });
  });
  it("searches imported documents with coercion/default count and preserves result order", async () => {
    searchMemory.mockResolvedValueOnce(["second", 0, "first"]);
    expect(await toolRegistry.getById("imported_docs")!.execute({ query: 42, topK: 0 })).toBe("second\n0\nfirst");
    expect(searchMemory).toHaveBeenLastCalledWith("42", "imported_doc", 5);
  });
  it("formats semantic memory entries and filters invalid result shapes", async () => {
    searchMemory.mockResolvedValueOnce(["plain", { entry: { text: "nested" }, text: "ignored" }, { text: "direct" }, null, 0, {}, { text: 4 }]);
    expect(await toolRegistry.getById("user_memory")!.execute({ query: "facts", topK: "2" })).toBe("plain\nnested\ndirect");
    expect(searchMemory).toHaveBeenLastCalledWith("facts", "user_memory", 2);
  });
  it("rejects invalid writes before loading memory storage", async () => {
    expect(await toolRegistry.getById("write_memory")!.execute({ layer: "L3", content: "x" }))
      .toBe("[错误] 参数无效：layer 必须是 L0/L1/L2，content 不能为空");
  });
});
