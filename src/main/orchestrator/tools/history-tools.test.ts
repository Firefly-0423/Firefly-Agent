import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addMemory: vi.fn(),
  isUserMemoryVectorStoreReady: vi.fn(),
  searchHistoryEntries: vi.fn(),
  register: vi.fn(),
}));

vi.mock("../../rag", () => ({
  addMemory: mocks.addMemory,
  isUserMemoryVectorStoreReady: mocks.isUserMemoryVectorStoreReady,
  searchHistoryEntries: mocks.searchHistoryEntries,
}));
vi.mock("./registry/tool-registry", () => ({ toolRegistry: { register: mocks.register } }));
vi.mock("./built-in-tools", () => ({ currentUserTimezone: () => "UTC" }));
vi.mock("../../locale-context", () => ({ getDateLocale: () => "zh-CN" }));

import { indexConversationTurn, registerRecallHistoryTool } from "./history-tools";

describe("conversation history vector indexing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isUserMemoryVectorStoreReady.mockReturnValue(true);
    mocks.addMemory.mockResolvedValue("vector-id");
  });

  it("reports unavailable without embedding or writing when the model is not ready", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.isUserMemoryVectorStoreReady.mockReturnValue(false);
      expect(await indexConversationTurn("session", "公开问题", "公开回答"))
        .toEqual({ status: "unavailable", indexed: 0 });
      expect(mocks.addMemory).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("[History]", expect.stringContaining("未就绪"));
    } finally {
      warn.mockRestore();
    }
  });

  it("counts two successful embeddings only after both writes resolve", async () => {
    expect(await indexConversationTurn("session", "公开问题", "公开回答"))
      .toEqual({ status: "complete", indexed: 2 });
    expect(mocks.addMemory).toHaveBeenCalledTimes(2);
  });

  it("reports a partial result when the second embedding fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.addMemory.mockResolvedValueOnce("vector-id").mockRejectedValueOnce(new Error("service failed"));
      expect(await indexConversationTurn("session", "公开问题", "公开回答"))
        .toEqual({ status: "partial", indexed: 1 });
      expect(warn).toHaveBeenCalledWith("[History]", expect.stringContaining("失败"), "Error");
    } finally {
      warn.mockRestore();
    }
  });

  it("reports failure without marking any embedding successful", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.addMemory.mockRejectedValueOnce(new Error("service failed"));
      expect(await indexConversationTurn("session", "公开问题", "公开回答"))
        .toEqual({ status: "failed", indexed: 0 });
    } finally {
      warn.mockRestore();
    }
  });

  it("returns unavailable from the recall tool instead of an empty-result claim", async () => {
    registerRecallHistoryTool();
    const tool = mocks.register.mock.calls[0][0] as { execute: (args: { query: string }) => Promise<string> };
    mocks.isUserMemoryVectorStoreReady.mockReturnValue(false);
    expect(await tool.execute({ query: "公开问题" })).toContain("未就绪");
    expect(mocks.searchHistoryEntries).not.toHaveBeenCalled();
  });
});
