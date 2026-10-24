import { describe, expect, it, vi } from "vitest";
import { estimateMessageTokens } from "../context-manager";
import type { ChatMessage } from "../vendors/types";
import { buildCompactionCheckpoint, computeTokenBudget, compressForAgentLoop, findSafeCutPointForRetainedTokens, isCompactionCheckpointMessage, isToolPairSafeBoundary } from "./compaction";

describe("Recoverable transcript compaction", () => {
  it("uses the window threshold and caps it at the usable input budget", () => {
    const estimate = (tokens: number, window: number, output = 0, margin = 0) =>
      computeTokenBudget("", [], [{ role: "user", content: "z".repeat(tokens * 4) }], window, output, margin);
    expect([estimate(84_000, 100_000).needsCompaction, estimate(86_000, 100_000).needsCompaction]).toEqual([false, true]);
    expect(estimate(1_900, 10_000, 8_000, 200)).toMatchObject({ needsCompaction: true, usableInputBudget: 1800 });
    expect(estimate(1_000, 10_000, 8_000, 200).needsCompaction).toEqual(false);
  });

  it("writes a trimmed checkpoint with a recognizable system envelope", () => {
    const checkpoint = buildCompactionCheckpoint("  待核对事实\n");
    expect(checkpoint).toEqual({ role: "system", content: "<firefly_compaction_checkpoint>\n待核对事实\n</firefly_compaction_checkpoint>" });
    expect(isCompactionCheckpointMessage(checkpoint)).toBe(true);
    expect(isCompactionCheckpointMessage({ ...checkpoint, role: "user" })).toBe(false);
  });

  it("moves the retained boundary back to include the declaration of a retained tool result", () => {
    const dialogue: ChatMessage[] = [
      { role: "user", content: "Earlier request" },
      { role: "assistant", content: "Inspecting", toolCalls: [{ id: "fetch-9", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "fetch-9", name: "read_file", content: "记录".repeat(90) },
      { role: "user", content: "继续整理".repeat(20) },
    ];
    const boundary = findSafeCutPointForRetainedTokens(dialogue, 100);
    expect(boundary).toEqual(1);
    expect(dialogue.slice(boundary).map(m => m.role)).toEqual(["assistant", "tool", "user"]);
  });

  it("preserves a partially returned parallel call group on the same side of a boundary", () => {
    const dialogue: ChatMessage[] = [
      { role: "user", content: "Collect entries" },
      { role: "assistant", content: "", toolCalls: ["lookup-left", "lookup-right"].map(id => ({ id, name: "read_file", arguments: "{}" })) },
      { role: "tool", toolCallId: "lookup-left", content: "left entry" },
    ];
    expect([2, 1, 0].map(cut => isToolPairSafeBoundary(dialogue, cut))).toEqual([false, true, true]);
  });

  const longHistory = (): ChatMessage[] => [
    { role: "user", content: "archive request ".repeat(100) },
    { role: "assistant", content: "archive observations ".repeat(100) },
    { role: "user", content: "new request ".repeat(30) },
  ];

  it.each(["throw", "blank", "expanded"] as const)("retains the original array when summarization is %s", async mode => {
    const messages = longHistory();
    const summarize = vi.fn(async () => {
      if (mode === "throw") throw new Error("summarizer offline");
      return mode === "blank" ? " \n" : "enlarged summary ".repeat(600);
    });
    expect(await compressForAgentLoop({ messages, retainTokens: 20, summarize })).toBe(messages);
    expect(summarize).toHaveBeenCalledExactlyOnceWith(messages.slice(0, 2));
  });

  it("replaces only the compressible prefix with a shorter checkpoint", async () => {
    const messages = longHistory();
    const summarize = vi.fn(async () => "已整理归档");
    expect(await compressForAgentLoop({ messages, retainTokens: 20, summarize })).toEqual([
      buildCompactionCheckpoint("已整理归档"), messages[2],
    ]);
    expect(estimateMessageTokens([buildCompactionCheckpoint("已整理归档")])).toBeLessThan(estimateMessageTokens(messages.slice(0, 2)));
  });
});
