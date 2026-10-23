import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const store = {
    getAllL2: vi.fn(),
    getL0: vi.fn(),
    getL1: vi.fn(),
    addL2Memory: vi.fn(),
    markL2SyncStatus: vi.fn(),
    archiveL2Batch: vi.fn(),
    updateL2Status: vi.fn(),
    deleteL2: vi.fn(),
    appendReflectionLog: vi.fn(),
    upsertL0Field: vi.fn(),
    replaceL1Field: vi.fn(),
  };
  return {
    store,
    getEntriesBySource: vi.fn(),
    cosineSimilarity: vi.fn(),
    resolveL1Field: vi.fn(),
    commit: vi.fn(),
    invokeLlm: vi.fn(),
    invokeStructured: vi.fn(),
    getDefaultMaxOutputTokens: vi.fn(),
    parse: vi.fn(),
    validate: vi.fn(),
  };
});

vi.mock("./memory-store", () => ({ memoryStore: mocks.store }));
vi.mock("../rag/index", () => ({
  addL2MemoryVector: vi.fn(),
  deleteUserMemoryVectors: vi.fn(),
  getEntriesBySource: mocks.getEntriesBySource,
}));
vi.mock("../rag/vectorstore", () => ({ cosineSimilarity: mocks.cosineSimilarity }));
vi.mock("./memory-manager", () => ({ resolveL1Field: mocks.resolveL1Field }));
vi.mock("./memory-compression-transaction", () => ({ commitMemoryCompression: mocks.commit }));
vi.mock("./memory-llm-client", () => ({
  invokeMemoryLlm: mocks.invokeLlm,
  invokeMemoryStructuredOutput: mocks.invokeStructured,
  getDefaultMaxOutputTokens: mocks.getDefaultMaxOutputTokens,
}));
vi.mock("./memory-schemas", () => ({
  parseMemoryReflectionResult: mocks.parse,
  validateMemoryReflectionBusiness: mocks.validate,
}));

import { runMemoryCompression, runReflectionAndCompression } from "./memory-compressor";

const l0 = (over: Record<string, unknown> = {}) => ({
  nickname: "",
  preferredName: "",
  occupation: "工程师",
  longTermInterests: "",
  language: "中文",
  permanentNote: "",
  isPinned: false,
  updatedAt: 0,
  ...over,
});

const l1 = (over: Record<string, unknown> = {}) => ({
  recentGoals: "",
  recentPreferences: "",
  currentProject: "",
  generatedAt: 0,
  roundCount: 42,
  ...over,
});

const l2 = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  content: `记忆 ${id}`,
  triggerText: `触发 ${id}`,
  sourceConversationId: "conv-1",
  createdAt: 0,
  lastAccessedAt: 0,
  accessCount: 0,
  weight: 1,
  isPinned: false,
  status: "active",
  ragId: `rag-${id}`,
  ...over,
});

const ragEntry = (id: string, embedding: number[]) => ({ id: `rag-${id}`, embedding });

function groupOf(ids: string[], embedding = [1, 0]) {
  return {
    entries: ids.map(id => l2(id)),
    rag: ids.map(id => ragEntry(id, embedding)),
  };
}

function installGroup(group: ReturnType<typeof groupOf>) {
  mocks.store.getAllL2.mockResolvedValue(group.entries);
  mocks.getEntriesBySource.mockReturnValue(group.rag);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.getL0.mockResolvedValue(l0());
  mocks.store.getL1.mockResolvedValue(l1());
  mocks.store.getAllL2.mockResolvedValue([]);
  mocks.store.addL2Memory.mockResolvedValue({ id: "summary-1" });
  mocks.store.markL2SyncStatus.mockResolvedValue(undefined);
  mocks.store.archiveL2Batch.mockResolvedValue(undefined);
  mocks.store.updateL2Status.mockResolvedValue(undefined);
  mocks.store.deleteL2.mockResolvedValue(undefined);
  mocks.store.appendReflectionLog.mockResolvedValue(undefined);
  mocks.store.upsertL0Field.mockResolvedValue(undefined);
  mocks.store.replaceL1Field.mockResolvedValue(undefined);
  mocks.commit.mockResolvedValue({ summaryId: "summary-1", ragId: "rag-summary" });
  mocks.invokeStructured.mockResolvedValue([]);
  mocks.invokeLlm.mockResolvedValue({ text: "合并后的总结内容" });
  mocks.getDefaultMaxOutputTokens.mockReturnValue(500);
  mocks.cosineSimilarity.mockReturnValue(1);
  mocks.resolveL1Field.mockImplementation((field: string | undefined) => field ?? "recentGoals");
  mocks.getEntriesBySource.mockReturnValue([]);
});

describe("runMemoryCompression orchestration", () => {
  it("runs the reflection pass before the compression pass", async () => {
    mocks.store.getAllL2.mockResolvedValue([l2("a"), l2("b")]);
    await runMemoryCompression();
    expect(mocks.store.getL0).toHaveBeenCalledTimes(1);
    expect(mocks.store.getL1).toHaveBeenCalledTimes(1);
    expect(mocks.store.getAllL2).toHaveBeenCalledTimes(1);
    expect(mocks.store.getL1.mock.invocationCallOrder[0]).toBeLessThan(mocks.store.getAllL2.mock.invocationCallOrder[0]);
    expect(mocks.getEntriesBySource).not.toHaveBeenCalled();
  });

  it("keeps the deprecated alias pointed at the same entry point", async () => {
    expect(runReflectionAndCompression).toBe(runMemoryCompression);
    await runReflectionAndCompression();
    expect(mocks.store.getL0).toHaveBeenCalled();
  });

  it("sends the profile and reflection schema settings to the structured LLM call", async () => {
    mocks.store.getL0.mockResolvedValue(l0({ preferredName: "小王" }));
    await runMemoryCompression();
    expect(mocks.invokeStructured).toHaveBeenCalledTimes(1);
    const request = mocks.invokeStructured.mock.calls[0][0];
    expect(request).toMatchObject({
      operation: "reflect",
      maxOutputTokens: 500,
      parseSchema: mocks.parse,
      validateBusiness: mocks.validate,
    });
    expect(request.systemPrompt).toContain('"updates"');
    expect(request.userPrompt).toContain("称呼：小王");
    expect(request.userPrompt).toContain("对话轮数：42");
    expect(request.userPrompt).toContain("preferredName：");
  });
});

describe("reflection updates", () => {
  it("does nothing when the model suggests no updates", async () => {
    await runMemoryCompression();
    expect(mocks.store.upsertL0Field).not.toHaveBeenCalled();
    expect(mocks.store.replaceL1Field).not.toHaveBeenCalled();
    expect(mocks.store.appendReflectionLog).not.toHaveBeenCalled();
  });

  it("writes a trimmed valid L0 field and records a reflection log", async () => {
    mocks.invokeStructured.mockResolvedValue([
      { layer: "L0", field: "preferredName", content: "  小王  ", confidence: 0.9 },
    ]);
    await runMemoryCompression();
    expect(mocks.store.upsertL0Field).toHaveBeenCalledWith("preferredName", "小王");
    expect(mocks.store.appendReflectionLog).toHaveBeenCalledWith({
      type: "l0_update",
      summary: 'L0.preferredName 更新为 "  小王  "（置信度 0.90）',
    });
    expect(mocks.store.replaceL1Field).not.toHaveBeenCalled();
  });

  it("writes L1 updates through resolveL1Field with trimmed content", async () => {
    mocks.invokeStructured.mockResolvedValue([
      { layer: "L1", field: "recentGoals", content: "  系统学习 Transformer  ", confidence: 0.75 },
    ]);
    mocks.resolveL1Field.mockReturnValue("recentGoals");
    await runMemoryCompression();
    expect(mocks.resolveL1Field).toHaveBeenCalledWith("recentGoals", "  系统学习 Transformer  ");
    expect(mocks.store.replaceL1Field).toHaveBeenCalledWith("recentGoals", "系统学习 Transformer");
    expect(mocks.store.appendReflectionLog).toHaveBeenCalledWith({
      type: "l1_update",
      summary: 'L1.recentGoals 更新为 "  系统学习 Transformer  "（置信度 0.75）',
    });
    expect(mocks.store.upsertL0Field).not.toHaveBeenCalled();
  });

  it("resolves an L1 target when the model omits the field", async () => {
    mocks.invokeStructured.mockResolvedValue([
      { layer: "L1", content: "正在做桌面智能体", confidence: 0.61 },
    ]);
    mocks.resolveL1Field.mockReturnValue("currentProject");
    await runMemoryCompression();
    expect(mocks.resolveL1Field).toHaveBeenCalledWith(undefined, "正在做桌面智能体");
    expect(mocks.store.replaceL1Field).toHaveBeenCalledWith("currentProject", "正在做桌面智能体");
  });

  it.each([
    ["low confidence", { layer: "L0", field: "preferredName", content: "张三", confidence: 0.59 }],
    ["zero confidence", { layer: "L0", field: "preferredName", content: "张三", confidence: 0 }],
    ["empty content", { layer: "L0", field: "preferredName", content: "", confidence: 0.9 }],
    ["field outside L0_FIELD_DESCRIPTIONS", { layer: "L0", field: "nickname", content: "张三", confidence: 0.9 }],
    ["missing L0 field", { layer: "L0", content: "张三", confidence: 0.9 }],
  ])("skips an update with %s", async (_label, item) => {
    mocks.invokeStructured.mockResolvedValue([item]);
    await runMemoryCompression();
    expect(mocks.store.upsertL0Field).not.toHaveBeenCalled();
    expect(mocks.store.replaceL1Field).not.toHaveBeenCalled();
    expect(mocks.store.appendReflectionLog).not.toHaveBeenCalled();
  });

  it("skips L0 writes when the profile is pinned but still applies L1 updates", async () => {
    mocks.store.getL0.mockResolvedValue(l0({ isPinned: true }));
    mocks.invokeStructured.mockResolvedValue([
      { layer: "L0", field: "preferredName", content: "小王", confidence: 0.95 },
      { layer: "L1", field: "recentPreferences", content: "喜欢简洁回答", confidence: 0.8 },
    ]);
    await runMemoryCompression();
    expect(mocks.store.upsertL0Field).not.toHaveBeenCalled();
    expect(mocks.store.replaceL1Field).toHaveBeenCalledWith("recentPreferences", "喜欢简洁回答");
    expect(mocks.store.appendReflectionLog).toHaveBeenCalledTimes(1);
    expect(mocks.store.appendReflectionLog.mock.calls[0][0].type).toBe("l1_update");
  });

  it("swallows structured-output errors and still runs compression", async () => {
    mocks.invokeStructured.mockRejectedValue(new Error("model unavailable"));
    installGroup(groupOf(["a", "b", "c"]));
    await expect(runMemoryCompression()).resolves.toBeUndefined();
    expect(mocks.store.getAllL2).toHaveBeenCalled();
  });

  it("swallows non-Error structured-output rejections", async () => {
    mocks.invokeStructured.mockRejectedValue("plain failure");
    await expect(runMemoryCompression()).resolves.toBeUndefined();
  });
});

describe("fragment compression eligibility", () => {
  it("skips compression when fewer than three eligible active memories exist", async () => {
    mocks.store.getAllL2.mockResolvedValue([
      l2("a"),
      l2("b", { status: "aging" }),
      l2("c", { isSummary: true }),
      l2("d", { ragId: undefined }),
    ]);
    await runMemoryCompression();
    expect(mocks.getEntriesBySource).not.toHaveBeenCalled();
    expect(mocks.invokeLlm).not.toHaveBeenCalled();
  });

  it("skips groups that only reach two similar memories", async () => {
    mocks.store.getAllL2.mockResolvedValue([l2("a"), l2("b"), l2("c")]);
    mocks.getEntriesBySource.mockReturnValue([
      ragEntry("a", [1, 0]),
      ragEntry("b", [1, 0]),
      ragEntry("c", [0, 1]),
    ]);
    mocks.cosineSimilarity.mockImplementation((left: number[], right: number[]) => left[0] === right[0] ? 0.9 : 0.1);
    await runMemoryCompression();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("ignores eligible memories that have no RAG entry", async () => {
    mocks.store.getAllL2.mockResolvedValue([l2("a"), l2("b"), l2("c")]);
    mocks.getEntriesBySource.mockReturnValue([ragEntry("a", [1, 0]), ragEntry("b", [1, 0])]);
    await runMemoryCompression();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("does not compress when no entry reaches the similarity threshold", async () => {
    installGroup(groupOf(["a", "b", "c"]));
    mocks.cosineSimilarity.mockReturnValue(0.849);
    await runMemoryCompression();
    expect(mocks.invokeLlm).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });
});

describe("fragment compression commit", () => {
  it("summarizes a group and commits the sources with the summary metadata", async () => {
    installGroup(groupOf(["a", "b", "c"]));
    mocks.cosineSimilarity.mockReturnValue(0.85);
    mocks.invokeLlm.mockResolvedValue({ text: "「合并总结文本」" });

    await runMemoryCompression();

    expect(mocks.invokeLlm).toHaveBeenCalledTimes(1);
    const request = mocks.invokeLlm.mock.calls[0][0];
    expect(request).toMatchObject({ operation: "compress", maxOutputTokens: 300 });
    expect(request.messages[1].content).toContain("- 记忆 a");
    expect(request.messages[1].content).toContain("- 记忆 c");

    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.commit.mock.calls[0][0]).toEqual({
      content: "合并总结文本",
      triggerText: "触发 a",
      sourceConversationId: "conv-1",
      sources: [
        { id: "a", ragId: "rag-a", status: "active" },
        { id: "b", ragId: "rag-b", status: "active" },
        { id: "c", ragId: "rag-c", status: "active" },
      ],
    });
    expect(mocks.store.appendReflectionLog).toHaveBeenCalledWith({
      type: "compression",
      summary: "压缩 3 条记忆为一条总结",
      details: expect.stringContaining("总结：合并总结文本"),
    });
  });

  it("includes every similar entry in one group and compresses it once", async () => {
    installGroup(groupOf(["a", "b", "c", "d"]));
    mocks.cosineSimilarity.mockReturnValue(1);
    await runMemoryCompression();
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.commit.mock.calls[0][0].sources.map((source: { id: string }) => source.id)).toEqual(["a", "b", "c", "d"]);
    expect(mocks.store.appendReflectionLog.mock.calls[0][0].summary).toBe("压缩 4 条记忆为一条总结");
  });

  it.each([
    ["empty", ""],
    ["too short", "短"],
    ["blank after quotes are stripped", '""'],
  ])("skips a summary that is %s", async (_label, text) => {
    installGroup(groupOf(["a", "b", "c"]));
    mocks.invokeLlm.mockResolvedValue({ text });
    await runMemoryCompression();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.store.appendReflectionLog).not.toHaveBeenCalled();
  });

  it("keeps processing later groups when one group's LLM call fails", async () => {
    mocks.store.getAllL2.mockResolvedValue([l2("a"), l2("b"), l2("c"), l2("d"), l2("e"), l2("f")]);
    mocks.getEntriesBySource.mockReturnValue([
      ragEntry("a", [1]), ragEntry("b", [1]), ragEntry("c", [1]),
      ragEntry("d", [2]), ragEntry("e", [2]), ragEntry("f", [2]),
    ]);
    mocks.cosineSimilarity.mockImplementation((left: number[], right: number[]) => left[0] === right[0] ? 1 : 0);
    mocks.invokeLlm
      .mockRejectedValueOnce(new Error("first group failed"))
      .mockResolvedValueOnce({ text: "第二组总结文本" });

    await runMemoryCompression();

    expect(mocks.invokeLlm).toHaveBeenCalledTimes(2);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.commit.mock.calls[0][0].sources.map((source: { id: string }) => source.id)).toEqual(["d", "e", "f"]);
    expect(mocks.store.appendReflectionLog).toHaveBeenCalledTimes(1);
    expect(mocks.store.appendReflectionLog.mock.calls[0][0].summary).toBe("压缩 3 条记忆为一条总结");
  });

  it("swallows commit failures without recording a compression log", async () => {
    installGroup(groupOf(["a", "b", "c"]));
    mocks.commit.mockRejectedValue(new Error("transaction rolled back"));
    await expect(runMemoryCompression()).resolves.toBeUndefined();
    expect(mocks.store.appendReflectionLog).not.toHaveBeenCalled();
  });
});
