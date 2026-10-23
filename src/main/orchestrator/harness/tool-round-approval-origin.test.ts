import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import type { HarnessRun } from "./firefly-harness";
import { DEFAULT_HARNESS_CONFIG, type AgentState } from "./types";
import { StreamController } from "./stream-controller";
import { runToolRound } from "./tool-round";

describe("tool round approval origin", () => {
  it("tells the permission check which tool call is asking", async () => {
    const state: AgentState = { todoItems: [], uncertainEffects: [] };
    const tool: ToolDefinition = {
      id: "origin_fixture", name: "Origin fixture", description: "Synthetic operation", enabled: true,
      inputSchema: { type: "object", properties: {} }, effectKind: "read",
      execute: async () => "ok",
    };
    const checkPermission = vi.fn(async () => true);
    const controller = new AbortController();
    const run = {
      input: { tools: [tool], signal: controller.signal }, config: DEFAULT_HARNESS_CONFIG, state,
      toolDispatchContext: { state, tools: [tool], deferOutputPersistence: true, checkPermission },
      rounds: 0, messages: [], toolOutputs: [], toolCallStartedAt: new Map(),
      streamController: new StreamController(), checkpoint() {},
    } as unknown as HarnessRun;

    await runToolRound(run, [
      { id: "call-a", name: tool.id, arguments: "{}" },
      { id: "call-b", name: tool.id, arguments: "{}" },
    ]);

    expect(checkPermission.mock.calls.map((call) => call[3])).toEqual(
      expect.arrayContaining([{ toolCallId: "call-a" }, { toolCallId: "call-b" }]),
    );
    expect(checkPermission).toHaveBeenCalledTimes(2);
  });
});
