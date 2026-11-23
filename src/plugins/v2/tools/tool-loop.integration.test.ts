import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const sdkMock = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "C:\\tmp\\firefly-plugin-loop-test") },
}));
vi.mock("../../../main/base/storage/token-usage-store", () => ({
  recordModelCall: vi.fn(),
  recordToolCall: vi.fn(),
  recordUsage: vi.fn(),
  recordRequest: vi.fn(),
}));
vi.mock("../../../main/model/providers", async (original) => ({
  ...(await original<typeof import("../../../main/model/providers")>()),
  streamChatWithSdk: sdkMock.stream,
}));

import type { PluginManifestV1 } from "../../../shared/plugin-manifest";
import { HOST_TO_PLUGIN_METHODS } from "../../../shared/plugin-protocol";
import { createRpcEndpoint } from "../../../shared/plugin-rpc";
import { ToolRegistry } from "../../../main/tooling/registry/tool-registry";
import { runAgentLoop } from "../../../main/agent/loop/agent-loop";
import { PluginHostManager, type HostChild, type HostPort } from "../host";
import { createPluginToolService, pluginToolId } from "./index";

function createInMemoryChannel() {
  const listeners1 = new Set<(event: { data: unknown }) => void>();
  const listeners2 = new Set<(event: { data: unknown }) => void>();
  const port1: HostPort = {
    postMessage(frame) {
      queueMicrotask(() => {
        for (const l of [...listeners2]) l({ data: frame });
      });
    },
    on(_event, l) { listeners1.add(l); },
    removeListener(_event, l) { listeners1.delete(l); },
    start() {},
    close() { listeners1.clear(); },
  };
  const port2: HostPort = {
    postMessage(frame) {
      queueMicrotask(() => {
        for (const l of [...listeners1]) l({ data: frame });
      });
    },
    on(_event, l) { listeners2.add(l); },
    removeListener(_event, l) { listeners2.delete(l); },
    start() {},
    close() { listeners2.clear(); },
  };
  return { port1, port2 };
}

describe("G37 Item 6: Plugin tool effectKind and uncertainEffects gate in AgentLoop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records unknown on plugin crash, populates uncertainEffects, and blocks duplicate tool call on the next turn", async () => {
    let pluginExecuteCount = 0;
    const fakeChild = new EventEmitter() as EventEmitter & HostChild;
    Object.assign(fakeChild, {
      pid: 5150,
      postMessage: vi.fn((_msg: unknown, ports: HostPort[]) => {
        const pluginPort = ports[0];
        const pluginRpc = createRpcEndpoint({
          post: (frame) => pluginPort.postMessage(frame),
          onFrame: (cb) => {
            const listener = (event: { data: unknown }) => cb(event.data);
            pluginPort.on("message", listener);
            return () => { pluginPort.removeListener("message", listener); };
          },
        });
        pluginRpc.handle(HOST_TO_PLUGIN_METHODS.activate, async () => null);
        pluginRpc.handle(HOST_TO_PLUGIN_METHODS.toolExecute, async () => {
          pluginExecuteCount += 1;
          fakeChild.emit("exit", 1, null);
          return new Promise(() => {});
        });
        pluginPort.start();
      }),
      kill: vi.fn(() => true),
    });

    const manager = new PluginHostManager({
      resolvePlugin: () => ({
        entry: "dist/runtime/main.js",
        main: "dist/plugin/index.mjs",
        version: "1.0.0",
        permissions: [],
        dataDir: "C:\\tmp\\loop-crash-plugin",
      }),
      fork: () => {
        queueMicrotask(() => fakeChild.emit("spawn"));
        return fakeChild;
      },
      createChannel: createInMemoryChannel,
      getAppMetrics: () => [],
      prepareDataDir: () => {},
    });

    await manager.start("dev.firefly.notifier");

    const registry = new ToolRegistry();
    const service = createPluginToolService({ registry });
    const manifest: PluginManifestV1 = {
      schemaVersion: 1,
      id: "dev.firefly.notifier",
      name: "通知插件",
      version: "1.0.0",
      sdk: "^1.2.0",
      main: "dist/index.mjs",
      tools: [
        { name: "send_notice", title: "发送通知", risk: ["network"], modes: ["work"] },
      ],
    };
    service.registerTool({
      manifest,
      registration: {
        name: "send_notice",
        description: "Send external notification",
        parameters: {
          type: "object",
          properties: { to: { type: "string" } },
          required: ["to"],
        },
      },
      host: manager,
    });

    const toolId = pluginToolId(manifest.id, "send_notice");
    const toolDef = registry.getById(toolId)!;
    expect(toolDef.effectKind).toBe("external_side_effect");

    const capturedTurns: Array<Array<{ role: string; content: unknown; name?: string }>> = [];
    sdkMock.stream.mockImplementation(async ({ request }: { request: { messages: Array<{ role: string; content: unknown; name?: string }> } }) => {
      capturedTurns.push(request.messages.map((m) => ({ ...m })));
      const turnIndex = capturedTurns.length;
      if (turnIndex === 1 || turnIndex === 2) {
        const callId = `tc-${turnIndex}`;
        return {
          text: "",
          assistantMessage: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: callId, name: toolId, arguments: JSON.stringify({ to: "alice" }) }],
          },
          toolCalls: [{ id: callId, name: toolId, arguments: JSON.stringify({ to: "alice" }) }],
          finishReason: "tool_calls",
        };
      }
      return {
        text: "Cannot safely retry send_notice because its prior attempt is uncertain.",
        assistantMessage: {
          role: "assistant",
          content: "Cannot safely retry send_notice because its prior attempt is uncertain.",
        },
        toolCalls: [],
        finishReason: "stop",
      };
    });

    const result = await runAgentLoop({
      runId: "run-loop-crash",
      systemPrompt: "Test harness",
      messages: [{ role: "user", content: "Notify Alice" }],
      tools: [toolDef],
      toolContext: {
        userQuery: "Notify Alice",
        mode: "work",
        runId: "run-loop-crash",
        conversationId: "conv-loop-crash",
      },
      vendorConfig: {
        provider: "OpenAI",
        baseUrl: "https://example.invalid/v1",
        model: "gpt-test",
        apiKey: "test-key",
        explicitTransport: "openai",
      },
      config: { maxRounds: 5 },
    });

    expect(pluginExecuteCount).toBe(1);
    expect(result.finalState.uncertainEffects).toHaveLength(1);
    expect(result.finalState.uncertainEffects[0]).toMatchObject({
      toolCallId: "tc-1",
      toolName: toolId,
    });

    // Turn 2 received the "unknown" tool observation from Turn 1.
    const turn2ToolMsg = capturedTurns[1].find((m) => m.role === "tool" && m.name === toolId);
    expect(turn2ToolMsg).toBeDefined();
    expect(JSON.parse(String(turn2ToolMsg!.content))).toMatchObject({
      outcome: "unknown",
      toolSideEffect: "non_idempotent_side_effect",
    });

    // Turn 3 received the blocked "not_executed" observation when Turn 2 tried the exact same tool call.
    const turn3ToolMsgs = capturedTurns[2].filter((m) => m.role === "tool" && m.name === toolId);
    expect(turn3ToolMsgs).toHaveLength(2);
    expect(JSON.parse(String(turn3ToolMsgs[1]!.content))).toMatchObject({
      outcome: "not_executed",
      category: "runtime_safety",
    });
    expect(String(turn3ToolMsgs[1]!.content)).toContain("未确认结果");

    await manager.stop("dev.firefly.notifier");
  });
});
