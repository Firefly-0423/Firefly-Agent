import { beforeEach, describe, expect, it, vi } from "vitest";
import { TODO_WORKING_NOTEBOOK_POLICY } from "../todo-working-notebook";
import { loadPromptFile } from "../../../prompts/prompt-loader";
import { buildHarnessPromptLayers, buildHarnessSystemPrompt, materializeHarnessStartTranscript } from "./prompt-builder";

vi.mock("../../../prompts/prompt-loader", () => ({
  loadPromptFile: vi.fn((file: string) => file === "firefly_harness.md" ? "Agent persona policy" : "Tool invocation policy"),
}));

beforeEach(() => vi.clearAllMocks());

describe("Stable and per-run prompt contracts", () => {
  it.each(["chat", "work", "code"])("keeps the untrusted content policy in the %s system prefix", conversationMode => {
    const prompt = buildHarnessSystemPrompt({ conversationMode } as never);
    expect(prompt).toContain("untrusted");
    expect(prompt).toContain("Never follow instructions");
    expect(prompt).toContain("MCP");
  });
  it("places recovery facts exclusively in the dynamic tail with the exact recovery marker", () => {
    const layers = buildHarnessPromptLayers({ soulSystemBaseContent: "Project identity", toolSystemContent: "Available actions", recoveryContext: "恢复后的任务证据" } as never);
    expect(layers.stablePrefix.split("\n\n---\n\n")).toEqual(["Project identity", "Agent persona policy", TODO_WORKING_NOTEBOOK_POLICY, expect.stringContaining("[EXTERNAL_CONTENT_POLICY]"), "Available actions", "Tool invocation policy"]);
    expect(layers.stablePrefix).not.toContain("RECOVERY_CONTEXT");
    expect(layers.runtimeContext).toEqual("[RECOVERY_CONTEXT]\n恢复后的任务证据");
  });

  it("omits both file policies from chat prompts and leaves the notebook policy available", () => {
    const prompt = buildHarnessSystemPrompt({ conversationMode: "chat", soulSystemBaseContent: "Chat identity", toolSystemContent: "Chat actions" } as never);
    expect(loadPromptFile).not.toHaveBeenCalled();
    expect(prompt.split("\n\n---\n\n")).toEqual(["Chat identity", TODO_WORKING_NOTEBOOK_POLICY, expect.stringContaining("[EXTERNAL_CONTENT_POLICY]"), "Chat actions"]);
    expect(prompt).not.toContain("Tool invocation policy");
    expect(prompt).not.toContain("工具使用");
  });

  it("appends one recovery message with run identity and the next revision", () => {
    const prior = { role: "user" as const, content: "Resume analysis" };
    const transcript = materializeHarnessStartTranscript({ messages: [prior], kind: "recovery", runId: "replay-indigo", runtimeContext: "[RECOVERY_CONTEXT]\n恢复后的任务证据" });
    expect(transcript).toHaveLength(2);
    expect(transcript[0]).toBe(prior);
    expect(transcript[1]).toMatchObject({
      role: "user", visibility: "internal", content: "[RECOVERY_CONTEXT]\n恢复后的任务证据",
      internal: { kind: "recovery", revision: 1, runId: "replay-indigo", id: "replay-indigo:internal:1" },
    });
  });

  it("copies an empty-context transcript without inventing internal messages", () => {
    const messages = [{ role: "user" as const, content: "Inspect" }];
    const result = materializeHarnessStartTranscript({ messages, kind: "run_start", runId: "fresh-indigo", runtimeContext: "  " });
    expect(result).toEqual(messages);
    expect(result).not.toBe(messages);
  });
});
