import { afterEach, expect, it, vi } from "vitest";
import { createPluginAgentRunner } from "./plugin-agent";
import type { PluginTool } from "../../plugins/api";

afterEach(() => vi.restoreAllMocks());
const action = (patch: Partial<PluginTool> = {}): PluginTool => ({
  id: "garden-bot_water", name: "Water plants", description: "Water one garden plot", enabled: true,
  risk: "input-control", effectKind: "mutation", verificationPolicy: "none", needsContext: true, ledgerPolicy: "success_terminal",
  inputSchema: { properties: { plot: { type: "string" } }, required: ["plot"], type: "object" },
  execute: async () => "Watered", ...patch,
});
function runtime() {
  return { options: { settings: { provider: "garden-provider", baseUrl: "https://garden.invalid", model: "orchid",
    apiKey: "garden-key", contextWindowTokens: 64000 }, messages: [{ role: "user", content: "Water the seedlings" }],
    soulSystemBaseContent: "Garden personality", soulRuntimeContext: "Current garden weather",
    toolSystemContent: "Unrelated global tool list", skillLayerContent: "Garden skills" }, latestUserText: "Water the seedlings" };
}
function runner(deadline?: AbortSignal) {
  const harness = vi.fn(async (_input: any) => ({ finalAnswer: "Seedlings watered.", finalState: { todoItems: [], uncertainEffects: [] },
    terminated: false, rounds: 2 }));
  const build = vi.fn(async () => runtime());
  const run = createPluginAgentRunner({ pluginId: "garden-bot", pluginSignal: new AbortController().signal,
    userDataPath: "E:/garden-agent-fixture", agentRuntime: { buildOptions: build } as never, runHarness: harness as never,
    ...(deadline ? { createDeadline: () => deadline } : {}) });
  return { run, harness, build };
}
it("rejects tools without explicit effects before invoking the harness", async () => {
  const h = runner();
  await expect(h.run({ runId: "garden:invalid", goal: "Water the seedlings", tools: [action({ effectKind: undefined })] })).rejects.toThrow(/effectKind/);
  expect(h.harness).not.toHaveBeenCalled();
});
it("runs a restricted headless tool catalog and returns the explicit success result", async () => {
  const h = runner(), events: unknown[] = [];
  const result = await h.run({ runId: "garden:water", goal: "Water the seedlings", tools: [action()],
    maxRounds: 4, maxWallMs: 45000, onEvent: event => { events.push(event); } });
  expect(h.build).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "plugin:garden-bot", mode: "work",
    executionMode: "work", promptSource: "plugin-agent", promptChannel: "minecraft",
    messages: [{ role: "user", content: "Water the seedlings" }] }));
  const input = h.harness.mock.calls[0][0];
  expect(input).toMatchObject({ runId: "garden:water", tools: [expect.objectContaining({ id: "garden-bot_water",
    effectKind: "mutation", risk: "input-control", ledgerPolicy: "success_terminal", needsContext: true })],
    config: { maxRounds: 4, maxParallelToolCalls: 1, totalTimeoutMs: 45000 }, includeInteractiveTools: false,
    toolContext: { userQuery: "Water the seedlings", conversationId: "plugin:garden-bot", runId: "garden:water", mode: "work", permissionMode: "allow_all" } });
  expect(input.planState).toBeUndefined();
  expect(input.agentExecutor).toBeUndefined();
  expect(input.promptLayers.stablePrefix).toContain("garden-bot_water");
  expect(input.promptLayers.stablePrefix).not.toContain("Unrelated global tool list");
  expect(input.promptLayers.runtimeContext).toContain("Current garden weather");
  expect(events).toEqual([]);
  expect(result).toEqual({ text: "Seedlings watered.", terminal: { status: "success", externalEffectsMayContinue: false }, rounds: 2 });
});
it("prioritizes an elapsed deadline over the harness cancellation terminal", async () => {
  const h = runner(AbortSignal.abort());
  h.harness.mockResolvedValue({ finalAnswer: "", finalState: { todoItems: [], uncertainEffects: [] },
    terminated: true, terminateReason: "cancelled", terminal: { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true }, rounds: 2 } as never);
  const result = await h.run({ runId: "garden:deadline", goal: "Water the seedlings", tools: [action()], maxWallMs: 45000 });
  expect(h.harness.mock.calls[0][0].signal.aborted).toBe(true);
  expect(result.terminal).toEqual({ status: "timeout", reason: "timeout", externalEffectsMayContinue: true });
});
it("propagates a normalized purpose label into tool metadata and both lifecycle logs", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const h = runner();
  await h.run({ runId: "garden:label", goal: "Water the seedlings", tools: [action()], purpose: "morning watering" });
  const label = "plugin:garden-bot:morning-watering";
  expect(h.harness.mock.calls[0][0].toolContext.metadata).toEqual({ pluginAgentDiagnosticLabel: label });
  expect(log).toHaveBeenCalledWith("[plugin-agent] 无头任务开始", expect.objectContaining({ label }));
  expect(log).toHaveBeenCalledWith("[plugin-agent] 无头任务结束", expect.objectContaining({ label, status: "success" }));
});
