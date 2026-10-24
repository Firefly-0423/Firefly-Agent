import { afterEach, it, describe, expect, vi } from "vitest";
import type { ChatMessage, ChatSession } from "../../../../../shared/chat-types";
import { toUiMessages, permissionInteraction, stageForStep, normalizeWeatherData, getInitialMode, LAST_MODE_STORAGE_KEY } from "./chat-page-normalizers";

afterEach(() => vi.unstubAllGlobals());
function history(message: Partial<ChatMessage>): ChatSession {
  return { schemaVersion: 1, id: "archive-27", title: "Renderer history fixture", identityId: null,
    mode: "chat", createdAt: 40, updatedAt: 90, messages: [
      { id: "message-27", role: "user", at: 60, content: "请检查附件", ...message },
    ] };
}

describe("Saved data projected into a chat view", () => {
  it("adds defaults to Open-Meteo output and identifies executing tools", () => {
    const location = { city: "杭州", province: "浙江" };
    expect(normalizeWeatherData({ source: "open-meteo", location, weatherCode: 3, temp: 21,
      humidity: 72, windDeg: 90, windSpeed: 8 })).toStrictEqual({
      source: "open-meteo", location, weatherCode: 3, temp: 21, feelsLike: 21,
      humidity: 72, windDeg: 90, windSpeed: 8, precipitation: 0, pressure: 0,
    });
    expect(stageForStep("agent-graph-tool-read_file")).toStrictEqual({ detail: "read_file", kind: "executing" });
  });

  it("retains channel provenance and keeps model-only context separate", () => {
    const origin = { channel: "wechat" as const, chatType: "private" as const, senderName: "小夏" };
    const [direct] = toUiMessages(history({ channelSource: origin }));
    expect(direct.channelSource).toStrictEqual(origin);
    expect(direct.modelContext).toEqual(undefined);
    const hidden = "[QQ群发送者：小夏]\n请检查附件";
    const [group] = toUiMessages(history({ modelContext: hidden,
      channelSource: { channel: "qq", chatType: "group", senderName: "小夏" } }));
    expect(group.modelContext).toEqual(hidden);
    const malformed = history({ channelSource: { channel: "unsupported" } as unknown as ChatMessage["channelSource"] });
    expect(toUiMessages(malformed)[0].channelSource).toEqual(undefined);
  });

  it.each(["failed", "cancelled", "completed"] as const)("keeps %s delegation records across serialization without mutating storage", (status) => {
    const saved = history({ role: "model", content: "资料整理完毕",
      taskDelegations: [{ invocationId: "child-27", taskId: "docs-27", description: "整理引用",
        nickname: "艾利欧", assetFileName: "艾利欧.png", roundId: "turn-27", status }],
      runSnapshot: { runId: "run-27", status: "terminal", terminalStatus: "success", updatedAt: 90 } });
    const serialized = JSON.stringify(saved);
    for (const input of [saved, JSON.parse(serialized) as ChatSession])
      expect(toUiMessages(input)[0].taskDelegations).toStrictEqual(saved.messages[0].taskDelegations);
    expect(JSON.stringify(saved)).toEqual(serialized);
  });

  it.each(["interrupted", "unknown", "pending", "success"] as const)("lets canonical %s settlement override a stale running cache", (state) => {
    const saved = history({ role: "model", content: "stale display text", ttsCacheKey: "old-audio",
      runSnapshot: { runId: "run-28", status: "running", updatedAt: 90 },
      sSettlement: { state, runId: "run-28", assistantEntryId: "entry-28", originalText: "canonical response" } });
    const before = JSON.stringify(saved);
    const [view] = toUiMessages(saved);
    expect(view.content).toEqual(state === "success" ? "canonical response" : "");
    expect(view.streaming).toEqual(false);
    expect(view.sSettlement?.originalText).toEqual("canonical response");
    expect(view.runStage?.kind).toEqual(state === "success" ? "completed" : "failed");
    if (state !== "success") expect(view.ttsCacheKey).toEqual(undefined);
    expect(JSON.stringify(saved)).toEqual(before);
  });

  it("exposes child approval attribution only when the request supplies it", () => {
    const request = { id: "approval-27", toolId: "write_file", toolName: "Write file", toolDescription: "",
      args: { path: "notes.md" }, risk: "fs-write" as const, runId: "parent-27" };
    expect(permissionInteraction({ ...request, agentId: "document-agent", toolCallId: "tool-27", childRunId: "child-28" }))
      .toMatchObject({ id: "approval-27", kind: "permission", agentId: "document-agent", toolCallId: "tool-27", childRunId: "child-28" });
    const standalone = permissionInteraction(request);
    for (const omitted of ["agentId", "childRunId"]) expect(standalone).not.toHaveProperty(omitted);
  });
});

describe("Initial navigation mode", () => {
  it("uses the shared persisted key and defaults retired, absent and invalid modes to chat", () => {
    const memory = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null });
    expect(LAST_MODE_STORAGE_KEY).toEqual("firefly-react-last-mode");
    expect(getInitialMode()).toEqual("chat");
    for (const [stored, expected] of [["learn", "chat"], ["work", "work"], ["code", "code"], ["invalid-mode", "chat"]]) {
      memory.set("firefly-react-last-mode", stored);
      expect(getInitialMode()).toEqual(expected);
    }
  });
});
