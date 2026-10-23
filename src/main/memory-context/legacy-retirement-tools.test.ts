import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ searchMemory: vi.fn(), ready: vi.fn(), searchHistory: vi.fn(), addMemory: vi.fn() }));
vi.mock("../rag", () => ({ searchMemory: mocks.searchMemory, isUserMemoryVectorStoreReady: mocks.ready, searchHistoryEntries: mocks.searchHistory, addMemory: mocks.addMemory }));
vi.mock("../orchestrator/tools/built-in-tools", () => ({ currentUserTimezone: () => "UTC" }));
vi.mock("../locale-context", () => ({ getDateLocale: () => "en-US" }));
import { ToolRegistry, toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { indexConversationTurn, registerRecallHistoryTool } from "../orchestrator/tools/history-tools";

beforeEach(() => { vi.clearAllMocks(); toolRegistry.setPersonalMemoryMode?.("legacy"); mocks.searchMemory.mockResolvedValue(["knowledge"]); mocks.ready.mockReturnValue(true); mocks.searchHistory.mockResolvedValue([]); });
describe("Main SMH tool execution retirement", () => {
  it("rejects all legacy tools even through captured execution functions and enabled overrides", async () => {
    registerRecallHistoryTool();
    const ids = ["user_memory", "read_memory", "write_memory", "recall_history"];
    const captured = ids.map((id) => toolRegistry.getById(id)!);
    toolRegistry.setPersonalMemoryMode("smh");
    for (const tool of captured) {
      toolRegistry.setEnabled(tool.id, true);
      expect(await tool.execute({ query: "private", layer: "L0", content: "should not write" })).toBe("MEMORY_LEGACY_RETIRED");
    }
    expect(toolRegistry.getEnabledTools().some((tool) => ids.includes(tool.id))).toBe(false);
    expect(toolRegistry.getEnabledToolsForMode("work", Object.fromEntries(ids.map((id) => [id, { work: true }]))).some((tool) => ids.includes(tool.id))).toBe(false);
    expect(mocks.searchMemory).not.toHaveBeenCalled(); expect(mocks.searchHistory).not.toHaveBeenCalled(); expect(mocks.ready).not.toHaveBeenCalled();
    expect(await toolRegistry.getById("imported_docs")!.execute({ query: "book" })).toBe("knowledge");
    expect(mocks.searchMemory).toHaveBeenCalledWith("book", "imported_doc", 5);
  });
  it("guards replacements registered after retirement while leaving unrelated tools usable", async () => {
    const registry = new ToolRegistry({ personalMemoryMode: "smh" });
    let oldCalls = 0;
    const base = { name: "test", description: "test", enabled: true, inputSchema: { type: "object" as const, properties: {} }, execute: async () => { oldCalls++; return "executed"; } };
    const knowledge = { ...base, id: "knowledge_search" };
    registry.register({ ...base, id: "read_memory" }); registry.register(knowledge);
    expect(registry.getById("knowledge_search")).toBe(knowledge);
    expect(await registry.getById("read_memory")!.execute({})).toBe("MEMORY_LEGACY_RETIRED");
    expect(oldCalls).toBe(0);
    expect(await registry.getById("knowledge_search")!.execute({})).toBe("executed");
    expect(oldCalls).toBe(1);
  });
  it("retired history helper and recall registration refuse before readiness, embedding or search", async () => {
    registerRecallHistoryTool({ personalMemoryMode: "smh" });
    expect(await toolRegistry.getById("recall_history")!.execute({ query: "private" })).toBe("MEMORY_LEGACY_RETIRED");
    expect(await indexConversationTurn("session", "user", "assistant", { personalMemoryMode: "smh" })).toEqual({ status: "retired", indexed: 0, code: "MEMORY_LEGACY_RETIRED" });
    for (const fn of Object.values(mocks)) expect(fn).not.toHaveBeenCalled();
  });
});
