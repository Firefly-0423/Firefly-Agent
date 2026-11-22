import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const mockElectron = vi.hoisted(() => ({
  windows: [] as Array<{ webContents: { send: (channel: string, payload: unknown) => void } }>,
  sent: [] as Array<{ channel: string; payload: unknown }>,
  level: "read-only" as "read-only" | "per-action" | "full",
  userDataRoot: "",
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => mockElectron.userDataRoot || "C:\\tmp\\firefly-plugin-tools-test") },
  BrowserWindow: { getAllWindows: () => mockElectron.windows },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

vi.mock("../../../main/platform/interaction/toast-events", () => ({
  toastEvents: {
    publishApprovalPending: vi.fn(),
    publishApprovalSettled: vi.fn(),
  },
}));

import { IPC } from "../../../shared/ipc-channels";
import type { PluginManifestV1, PluginToolRisk } from "../../../shared/plugin-manifest";
import {
  HOST_TO_PLUGIN_METHODS,
  PLUGIN_TO_HOST_METHODS,
  PluginError,
  type Frame,
} from "../../../shared/plugin-protocol";
import { createRpcEndpoint, type RpcTransport } from "../../../shared/plugin-rpc";
import {
  answerApproval,
  checkPermission,
  setCurrentLevel,
} from "../../../main/platform/permission/permission";
import {
  policyFor,
  policyForPluginRisk,
  policyForTool,
  type AgentFileAccessLevel,
  type PolicyVerdict,
} from "../../../main/platform/permission/permission-policy";
import { ToolRegistry } from "../../../main/tooling/registry/tool-registry";
import { executeToolDefinition } from "../../../main/tooling/registry/tool-executor";
import { resolveRunCapabilities } from "../../../main/agent/runtime/run-capabilities";
import { dispatchToolCall } from "../../../main/agent/loop/tool-dispatcher";
import { prepareToolRuntime } from "../../../main/agent/runtime/adapter/tool-runtime";
import type { AgentState } from "../../../main/agent/loop/types";
import { PluginHostManager, type HostChild, type HostPort } from "../host";
import { createPluginContextProxy } from "../runtime/context";
import { evaluateToolPermission } from "../../../../plugin-sdk/src/testing";
import { createPluginToolService, pluginToolId, type PluginToolExecuteHost } from "./index";

function createPairedTransports(): [RpcTransport, RpcTransport] {
  const listenersA = new Set<(frame: unknown) => void>();
  const listenersB = new Set<(frame: unknown) => void>();
  const transportA: RpcTransport = {
    post(frame: Frame) {
      queueMicrotask(() => {
        for (const cb of [...listenersB]) cb(structuredClone(frame));
      });
    },
    onFrame(cb) {
      listenersA.add(cb);
      return () => { listenersA.delete(cb); };
    },
  };
  const transportB: RpcTransport = {
    post(frame: Frame) {
      queueMicrotask(() => {
        for (const cb of [...listenersA]) cb(structuredClone(frame));
      });
    },
    onFrame(cb) {
      listenersB.add(cb);
      return () => { listenersB.delete(cb); };
    },
  };
  return [transportA, transportB];
}

function makeManifest(overrides: Partial<PluginManifestV1> = {}): PluginManifestV1 {
  return {
    schemaVersion: 1,
    id: "dev.firefly.weather",
    name: "天气查询",
    version: "1.0.0",
    sdk: "^1.2.0",
    main: "dist/index.mjs",
    tools: [
      {
        name: "get_weather",
        title: "查询城市天气",
        risk: ["network"],
        modes: ["work", "code"],
      },
    ],
    ...overrides,
  };
}

function makeState(): AgentState {
  return { todoItems: [], uncertainEffects: [] };
}

describe("G37-1 Plugin tools: permission matrix (3 levels x 5 risks & multi-risk)", () => {
  const EXPECTED_PLUGIN_MATRIX: Record<AgentFileAccessLevel, Record<PluginToolRisk, PolicyVerdict>> = {
    "read-only": {
      "fs-read": "allow",
      "fs-write": "deny",
      shell: "ask",
      network: "allow",
      "input-control": "deny",
    },
    "per-action": {
      "fs-read": "ask",
      "fs-write": "ask",
      shell: "ask",
      network: "ask",
      "input-control": "ask",
    },
    full: {
      "fs-read": "allow",
      "fs-write": "allow",
      shell: "allow",
      network: "allow",
      "input-control": "allow",
    },
  };

  const singleRiskCases = (Object.keys(EXPECTED_PLUGIN_MATRIX) as AgentFileAccessLevel[]).flatMap((level) =>
    (Object.keys(EXPECTED_PLUGIN_MATRIX[level]) as PluginToolRisk[]).map((risk) => ({
      level,
      risk,
      expected: EXPECTED_PLUGIN_MATRIX[level][risk],
    })),
  );

  it.each(singleRiskCases)(
    "evaluates plugin single risk: $level + $risk -> $expected",
    ({ level, risk, expected }) => {
      expect(policyForPluginRisk(level, risk)).toBe(expected);
      expect(policyForTool(level, { risks: [risk], isPlugin: true })).toBe(expected);
    },
  );

  it("keeps built-in shell allow under read-only while elevating plugin shell to ask (Spec §7.2)", () => {
    expect(policyFor("read-only", "shell")).toBe("allow");
    expect(policyForTool("read-only", { risk: "shell", isPlugin: false })).toBe("allow");
    expect(policyForPluginRisk("read-only", "shell")).toBe("ask");
    expect(policyForTool("read-only", { risks: ["shell"], isPlugin: true })).toBe("ask");
  });

  const multiRiskCases: Array<{
    level: AgentFileAccessLevel;
    risks: PluginToolRisk[];
    expected: PolicyVerdict;
  }> = [
    { level: "read-only", risks: ["fs-read", "network"], expected: "allow" },
    { level: "read-only", risks: ["fs-read", "shell"], expected: "ask" },
    { level: "read-only", risks: ["network", "shell"], expected: "ask" },
    { level: "read-only", risks: ["fs-read", "fs-write"], expected: "deny" },
    { level: "read-only", risks: ["shell", "input-control"], expected: "deny" },
    { level: "per-action", risks: ["fs-read", "network"], expected: "ask" },
    { level: "per-action", risks: ["fs-write", "shell"], expected: "ask" },
    { level: "full", risks: ["fs-write", "shell", "input-control"], expected: "allow" },
  ];

  it.each(multiRiskCases)(
    "takes strictest verdict for multi-risk plugin tool: $level + $risks -> $expected",
    ({ level, risks, expected }) => {
      expect(policyForTool(level, { risks, isPlugin: true })).toBe(expected);
    },
  );

  it("denies plugin tools with empty risks or safe risk (fail-closed)", () => {
    expect(policyForTool("full", { risks: [], isPlugin: true })).toBe("deny");
    expect(policyForTool("full", { risks: ["safe"], isPlugin: true })).toBe("deny");
  });

  it.each(singleRiskCases)(
    "matches createTestHost evaluateToolPermission with host policyForTool / policyForPluginRisk: $level + $risk",
    ({ level, risk }) => {
      const hostVerdict = policyForTool(level, { risks: [risk], isPlugin: true });
      expect(policyForPluginRisk(level, risk)).toBe(hostVerdict);
      expect(evaluateToolPermission(level, [risk])).toBe(hostVerdict);
    },
  );

  it.each(multiRiskCases)(
    "matches createTestHost evaluateToolPermission for multi-risk: $level + $risks",
    ({ level, risks }) => {
      expect(evaluateToolPermission(level, risks)).toBe(
        policyForTool(level, { risks, isPlugin: true }),
      );
    },
  );
});

describe("G37-1 Plugin tools: registration, modes, schema validation, approval & 4 result states", () => {
  beforeEach(() => {
    mockElectron.sent = [];
    mockElectron.windows = [
      {
        webContents: {
          send(channel, payload) {
            mockElectron.sent.push({ channel, payload });
          },
        },
      },
    ];
    setCurrentLevel("read-only");
  });

  afterEach(() => {
    setCurrentLevel("read-only");
    vi.restoreAllMocks();
  });

  it("rejects tools.register with ERR_UNDECLARED when tool is absent from manifest", async () => {
    const registry = new ToolRegistry();
    const service = createPluginToolService({ registry });
    const host: PluginToolExecuteHost = { call: vi.fn() };
    const manifest = makeManifest();

    let caught: unknown;
    try {
      service.registerTool({
        manifest,
        registration: {
          name: "undeclared_tool",
          description: "Not in manifest",
          parameters: { type: "object", properties: {} },
        },
        host,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe("ERR_UNDECLARED");
    expect(registry.getAllTools()).toHaveLength(0);
  });

  it("handles tools.register over RPC and returns ERR_UNDECLARED for undeclared tool", async () => {
    const [hostTransport, pluginTransport] = createPairedTransports();
    const hostRpc = createRpcEndpoint(hostTransport);
    const pluginRpc = createRpcEndpoint(pluginTransport);
    const registry = new ToolRegistry();
    const service = createPluginToolService({ registry });
    const manifest = makeManifest();

    const host: PluginToolExecuteHost = {
      call: (_id, method, params, opts) => hostRpc.call(method, params, opts),
    };
    service.bindRpc(manifest, hostRpc, host);

    const stopController = new AbortController();
    const { ctx, awaitPendingRegistrations } = createPluginContextProxy({
      id: manifest.id,
      version: manifest.version,
      dataDir: "C:\\tmp\\plugin-data",
      permissions: [],
      signal: stopController.signal,
      rpc: pluginRpc,
    });

    const executeSpy = vi.fn(async () => ({ status: "succeeded", output: { temp: 22 } }));
    ctx.tools.register({
      name: "get_weather",
      description: "Query weather by city",
      parameters: {
        type: "object",
        properties: { city: { type: "string", minLength: 1 } },
        required: ["city"],
        additionalProperties: false,
      },
      execute: executeSpy,
    });
    await awaitPendingRegistrations();

    const toolId = pluginToolId(manifest.id, "get_weather");
    expect(registry.getById(toolId)).toBeDefined();

    // Calling tools.register directly for an undeclared tool fails with ERR_UNDECLARED over RPC.
    await expect(
      pluginRpc.call(PLUGIN_TO_HOST_METHODS.toolsRegister, {
        name: "rogue_tool",
        description: "evil",
        parameters: { type: "object", properties: {} },
      }),
    ).rejects.toMatchObject({ name: "PluginError", code: "ERR_UNDECLARED" });

    // End-to-end tool execution over RPC succeeds.
    const result = await service.executeTool(
      manifest.id,
      "get_weather",
      { city: "杭州" },
      { callId: "call-rpc-1", sessionId: "sess-1", mode: "work", caller: "firefly" },
    );
    expect(result).toEqual({ status: "succeeded", output: { temp: 22 } });
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({
      callId: "call-rpc-1",
      sessionId: "sess-1",
      mode: "work",
      caller: "firefly",
    });

    hostRpc.dispose();
    pluginRpc.dispose();
  });

  it("removes tool from PluginToolService and ToolRegistry when plugin calls dispose()", async () => {
    const [hostTransport, pluginTransport] = createPairedTransports();
    const hostRpc = createRpcEndpoint(hostTransport);
    const pluginRpc = createRpcEndpoint(pluginTransport);
    const registry = new ToolRegistry();
    const service = createPluginToolService({ registry });
    const manifest = makeManifest();

    const host: PluginToolExecuteHost = {
      call: (_id, method, params, opts) => hostRpc.call(method, params, opts),
    };
    service.bindRpc(manifest, hostRpc, host);

    const stopController = new AbortController();
    const { ctx, awaitPendingRegistrations } = createPluginContextProxy({
      id: manifest.id,
      version: manifest.version,
      dataDir: "C:\\tmp\\plugin-data",
      permissions: [],
      signal: stopController.signal,
      rpc: pluginRpc,
    });

    const executeSpy = vi.fn(async () => ({ status: "succeeded", output: "sunny" }));
    const disposable = ctx.tools.register({
      name: "get_weather",
      description: "Query weather by city",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      execute: executeSpy,
    });
    await awaitPendingRegistrations();

    const toolId = pluginToolId(manifest.id, "get_weather");
    expect(registry.getById(toolId)).toBeDefined();
    expect(service.getTool(manifest.id, "get_weather")).toBeDefined();

    disposable.dispose();
    await vi.waitFor(() => {
      expect(registry.getById(toolId)).toBeUndefined();
      expect(service.getTool(manifest.id, "get_weather")).toBeUndefined();
    });

    const afterDispose = await service.executeTool(manifest.id, "get_weather", { city: "上海" }, { mode: "work" });
    expect(afterDispose.status).toBe("not_executed");
    expect((afterDispose as { reason: string }).reason).toContain("ERR_UNDECLARED");
    expect(executeSpy).not.toHaveBeenCalled();

    hostRpc.dispose();
    pluginRpc.dispose();
  });

  it("exposes plugin tools ONLY in work and code modes and NEVER in chat mode (even with overrides)", async () => {
    const registry = new ToolRegistry();
    const service = createPluginToolService({ registry });
    const hostCall = vi.fn(async () => ({ status: "succeeded", output: "ok" }));
    const manifest = makeManifest({
      tools: [
        { name: "work_only", title: "Work Only", risk: ["network"], modes: ["work"] },
        { name: "work_and_code", title: "Work & Code", risk: ["fs-read"], modes: ["work", "code"] },
      ],
    });

    service.registerTool({
      manifest,
      registration: { name: "work_only", description: "work only", parameters: { type: "object", properties: {} } },
      host: { call: hostCall },
    });
    service.registerTool({
      manifest,
      registration: { name: "work_and_code", description: "work and code", parameters: { type: "object", properties: {} } },
      host: { call: hostCall },
    });

    const workId = pluginToolId(manifest.id, "work_only");
    const bothId = pluginToolId(manifest.id, "work_and_code");

    expect(registry.getEnabledToolsForMode("work").map((t) => t.id)).toEqual([workId, bothId]);
    expect(registry.getEnabledToolsForMode("code").map((t) => t.id)).toEqual([bothId]);
    expect(registry.getById(workId)?.effectKind).toBe("external_side_effect");
    expect(registry.getById(bothId)?.effectKind).toBe("read");

    // Even if custom toolModeOverrides tries to enable plugin tools in chat, chat stays empty.
    const overrides = { [workId]: { chat: true }, [bothId]: { chat: true } };
    expect(registry.getEnabledToolsForMode("chat", overrides)).toEqual([]);

    const chatCaps = resolveRunCapabilities({
      mode: "chat",
      chatToolsEnabled: true,
      toolModeOverrides: overrides,
      activeSearchBackend: "off",
      toolRegistry: registry,
      skillRegistry: { getEnabledForMode: () => [] },
    });
    expect(chatCaps.tools).toEqual([]);

    // Executing directly in chat mode is blocked without calling plugin process.
    const chatRes = await service.executeTool(manifest.id, "work_and_code", {}, { mode: "chat" });
    expect(chatRes.status).toBe("not_executed");
    expect((chatRes as { reason: string }).reason).toContain("ERR_PERMISSION");
    expect(hostCall).not.toHaveBeenCalled();
  });

  it("validates args against JSON Schema on host before invoking plugin and returns ERR_INVALID_ARGUMENT", async () => {
    const registry = new ToolRegistry();
    const service = createPluginToolService({ registry });
    const hostCall = vi.fn(async () => ({ status: "succeeded", output: "should-not-run" }));
    const manifest = makeManifest();

    service.registerTool({
      manifest,
      registration: {
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string", minLength: 1 },
            days: { type: "integer", minimum: 1, maximum: 7 },
          },
          required: ["city"],
          additionalProperties: false,
        },
      },
      host: { call: hostCall },
    });

    const toolId = pluginToolId(manifest.id, "get_weather");
    const toolDef = registry.getById(toolId)!;

    // 1. Direct executeTool with missing required field
    const directInvalid = await service.executeTool(manifest.id, "get_weather", { days: 3 }, { mode: "work" });
    expect(directInvalid.status).toBe("not_executed");
    expect((directInvalid as { reason: string }).reason).toContain("ERR_INVALID_ARGUMENT");
    expect(hostCall).not.toHaveBeenCalled();

    // 2. Via dispatchToolCall with wrong type / extra field -> not_executed, no permission check or plugin call
    const checkPermission = vi.fn(async () => true);
    const dispatched = await dispatchToolCall(
      { id: "tc-invalid-1", name: toolId, arguments: JSON.stringify({ city: "", days: 99, extra: true }) },
      {
        state: makeState(),
        tools: [toolDef],
        checkPermission,
        toolContext: { userQuery: "weather", mode: "work", runId: "run-1", conversationId: "sess-1" },
      },
    );
    expect(dispatched.outcome).toBe("not_executed");
    expect(dispatched.category).toBe("invalid_arguments");
    expect(dispatched.message).toContain("ERR_INVALID_ARGUMENT");
    expect(dispatched.rawResult?.errorCode).toBe("ERR_INVALID_ARGUMENT");
    expect(checkPermission).not.toHaveBeenCalled();
    expect(hostCall).not.toHaveBeenCalled();
  });

  it("never calls plugin execute when permission is denied or user rejects approval", async () => {
    const registry = new ToolRegistry();
    const service = createPluginToolService({ registry });
    const hostCall = vi.fn(async () => ({ status: "succeeded", output: "forbidden" }));
    const manifest = makeManifest({
      tools: [
        { name: "write_note", title: "写入笔记", risk: ["fs-write"], modes: ["work", "code"] },
        { name: "run_cmd", title: "执行插件命令", risk: ["shell"], modes: ["work", "code"] },
      ],
    });

    service.registerTool({
      manifest,
      registration: {
        name: "write_note",
        description: "Write note",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
      host: { call: hostCall },
    });
    service.registerTool({
      manifest,
      registration: {
        name: "run_cmd",
        description: "Run cmd",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      },
      host: { call: hostCall },
    });

    // Case A: read-only + fs-write -> denied by policy without prompting user or calling plugin
    setCurrentLevel("read-only");
    const writeId = pluginToolId(manifest.id, "write_note");
    const writeTool = registry.getById(writeId)!;
    const deniedResult = await dispatchToolCall(
      { id: "tc-deny-1", name: writeId, arguments: JSON.stringify({ text: "hello" }) },
      {
        state: makeState(),
        tools: [writeTool],
        checkPermission: async (id, args, signal, origin) => {
          const decision = await checkPermission({
            toolId: id,
            toolName: writeTool.name,
            toolDescription: writeTool.description,
            args,
            risk: writeTool.risk ?? "safe",
            risks: writeTool.risks,
            isPlugin: true,
            declaredBy: writeTool.pluginMeta?.pluginName,
            runId: "run-deny",
            origin,
            signal,
          });
          return decision.allowed;
        },
        toolContext: { userQuery: "write", mode: "work", runId: "run-deny", conversationId: "sess-1" },
      },
    );
    expect(deniedResult.outcome).toBe("failure");
    expect(deniedResult.category).toBe("permission_denied");
    expect(mockElectron.sent.filter((e) => e.channel === IPC.PERMISSION_APPROVAL_REQUEST)).toHaveLength(0);
    expect(hostCall).not.toHaveBeenCalled();

    // Case B: read-only + shell -> asks user; user rejects -> plugin execute NEVER called
    const shellId = pluginToolId(manifest.id, "run_cmd");
    const shellTool = registry.getById(shellId)!;
    const pending = dispatchToolCall(
      { id: "tc-shell-reject", name: shellId, arguments: JSON.stringify({ cmd: "whoami" }) },
      {
        state: makeState(),
        tools: [shellTool],
        checkPermission: async (id, args, signal, origin) => {
          const decision = await checkPermission({
            toolId: id,
            toolName: shellTool.name,
            toolDescription: shellTool.description,
            args,
            risk: shellTool.risk ?? "safe",
            risks: shellTool.risks,
            isPlugin: true,
            declaredBy: shellTool.pluginMeta?.pluginName,
            runId: "run-reject",
            origin,
            signal,
          });
          return decision.allowed;
        },
        toolContext: { userQuery: "cmd", mode: "work", runId: "run-reject", conversationId: "sess-1" },
      },
    );

    await vi.waitFor(() => {
      expect(mockElectron.sent.some((e) => e.channel === IPC.PERMISSION_APPROVAL_REQUEST)).toBe(true);
    });
    const approvalPayload = mockElectron.sent.find((e) => e.channel === IPC.PERMISSION_APPROVAL_REQUEST)!.payload as {
      id: string;
      declaredBy?: string;
    };
    expect(approvalPayload.declaredBy).toBe("天气查询");
    expect(answerApproval(approvalPayload.id, false)).toBe(true);

    const rejectedResult = await pending;
    expect(rejectedResult.outcome).toBe("failure");
    expect(rejectedResult.category).toBe("permission_denied");
    expect(hostCall).not.toHaveBeenCalled();
  });

  it("includes declaredBy and partner attribution on approval cards and forwards caller to plugin", async () => {
    const registry = new ToolRegistry();
    const service = createPluginToolService({ registry });
    const hostCall = vi.fn(async () => ({ status: "succeeded", output: { ok: true } }));
    const manifest = makeManifest({
      id: "dev.firefly.builder",
      name: "构建助手",
      tools: [{ name: "run_build", title: "运行构建", risk: ["shell"], modes: ["work", "code"] }],
    });
    service.registerTool({
      manifest,
      registration: {
        name: "run_build",
        description: "Run build",
        parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
      },
      host: { call: hostCall },
    });

    setCurrentLevel("read-only");
    const toolId = pluginToolId(manifest.id, "run_build");
    const toolDef = registry.getById(toolId)!;

    const partner = { partnerId: "implementation", partnerName: "刃" };
    const pending = dispatchToolCall(
      { id: "tc-partner-1", name: toolId, arguments: JSON.stringify({ target: "main" }) },
      {
        state: makeState(),
        tools: [toolDef],
        checkPermission: async (id, args, signal) => {
          const decision = await checkPermission({
            toolId: id,
            toolName: toolDef.name,
            toolDescription: toolDef.description,
            args,
            risk: toolDef.risk ?? "safe",
            risks: toolDef.risks,
            isPlugin: true,
            declaredBy: toolDef.pluginMeta?.pluginName,
            runId: "run-partner",
            origin: { agentId: partner.partnerId, agentName: partner.partnerName, childRunId: "child-1", toolCallId: "tc-partner-1" },
            signal,
          });
          return decision.allowed;
        },
        toolContext: {
          userQuery: "build",
          mode: "code",
          runId: "child-1",
          conversationId: "sess-1",
          caller: partner,
        },
      },
    );

    await vi.waitFor(() => {
      expect(mockElectron.sent.some((e) => e.channel === IPC.PERMISSION_APPROVAL_REQUEST)).toBe(true);
    });
    const req = mockElectron.sent.find((e) => e.channel === IPC.PERMISSION_APPROVAL_REQUEST)!.payload as {
      id: string;
      declaredBy?: string;
      agentId?: string;
      agentName?: string;
      risks?: string[];
    };
    expect(req.declaredBy).toBe("构建助手");
    expect(req.agentId).toBe("implementation");
    expect(req.agentName).toBe("刃");
    expect(req.risks).toEqual(["shell"]);

    answerApproval(req.id, true);
    const result = await pending;

    expect(result.outcome).toBe("success");
    expect(hostCall).toHaveBeenCalledTimes(1);
    expect(hostCall).toHaveBeenCalledWith(
      "dev.firefly.builder",
      HOST_TO_PLUGIN_METHODS.toolExecute,
      {
        name: "run_build",
        args: { target: "main" },
        callId: "tc-partner-1",
        sessionId: "sess-1",
        mode: "code",
        caller: { partnerId: "implementation", partnerName: "刃" },
      },
      expect.any(Object),
    );
  });

  it("supports all 4 tool result states (succeeded, failed, not_executed, unknown)", async () => {
    const registry = new ToolRegistry();
    const service = createPluginToolService({ registry });
    const responses = [
      { status: "succeeded", output: { forecast: "晴" } },
      { status: "failed", error: "upstream 503", retryable: true },
      { status: "not_executed", reason: "missing api key" },
      { status: "unknown", reason: "connection dropped after request sent", possibleEffects: "order may exist" },
    ];
    let index = 0;
    const hostCall = vi.fn(async () => responses[index++]);

    const manifest = makeManifest();
    service.registerTool({
      manifest,
      registration: {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
      host: { call: hostCall },
    });

    const toolId = pluginToolId(manifest.id, "get_weather");
    const toolDef = registry.getById(toolId)!;
    const state = makeState();
    const ctx = {
      state,
      tools: [toolDef],
      toolContext: { userQuery: "weather", mode: "work" as const, runId: "run-4states", conversationId: "sess-4" },
    };

    const r1 = await dispatchToolCall({ id: "c1", name: toolId, arguments: '{"city":"A"}' }, ctx);
    expect(r1.outcome).toBe("success");
    expect(r1.output).toBe(JSON.stringify({ forecast: "晴" }));

    const r2 = await dispatchToolCall({ id: "c2", name: toolId, arguments: '{"city":"B"}' }, ctx);
    expect(r2.outcome).toBe("failure");
    expect(r2.retryDecision).toBe("retry");
    expect(r2.message).toContain("upstream 503");

    const r3 = await dispatchToolCall({ id: "c3", name: toolId, arguments: '{"city":"C"}' }, ctx);
    expect(r3.outcome).toBe("not_executed");
    expect(r3.message).toContain("missing api key");

    const r4 = await dispatchToolCall({ id: "c4", name: toolId, arguments: '{"city":"D"}' }, ctx);
    expect(r4.outcome).toBe("unknown");
    expect(r4.message).toContain("connection dropped after request sent");
    expect(state.uncertainEffects).toHaveLength(1);
    expect(state.uncertainEffects[0].toolCallId).toBe("c4");
  });

  it("maps plugin process crash during tool.execute to unknown via PluginHostManager", async () => {
    const fakeChild = new EventEmitter() as EventEmitter & HostChild;
    Object.assign(fakeChild, {
      pid: 4242,
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
          // Simulate child process crashing while executing tool.
          fakeChild.emit("exit", 1, null);
          return new Promise(() => {});
        });
        pluginPort.start();
      }),
      kill: vi.fn(() => true),
    });

    const createChannel = () => {
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
    };

    const manager = new PluginHostManager({
      resolvePlugin: () => ({
        entry: "dist/index.mjs",
        main: "dist/index.mjs",
        version: "1.0.0",
        permissions: [],
        dataDir: "C:\\tmp\\crash-plugin",
      }),
      fork: () => {
        queueMicrotask(() => fakeChild.emit("spawn"));
        return fakeChild;
      },
      createChannel,
      getAppMetrics: () => [],
      prepareDataDir: () => {},
    });

    await manager.start("dev.firefly.weather");

    const registry = new ToolRegistry();
    const service = createPluginToolService({ registry });
    const manifest = makeManifest();
    service.registerTool({
      manifest,
      registration: {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
      host: manager,
    });

    const toolId = pluginToolId(manifest.id, "get_weather");
    const toolDef = registry.getById(toolId)!;
    const state = makeState();

    const dispatched = await dispatchToolCall(
      { id: "tc-crash-1", name: toolId, arguments: JSON.stringify({ city: "杭州" }) },
      {
        state,
        tools: [toolDef],
        toolContext: { userQuery: "weather", mode: "work", runId: "run-crash", conversationId: "sess-crash" },
      },
    );

    expect(dispatched.outcome).toBe("unknown");
    expect(dispatched.message).toContain("Plugin process exited during tool execution");
    expect(state.uncertainEffects).toHaveLength(1);

    await manager.stop("dev.firefly.weather");
  });

  it("wires plugin shell -> ask and declaredBy attribution through prepareToolRuntime", async () => {
    const registry = new ToolRegistry();
    const service = createPluginToolService({ registry });
    const manifest = makeManifest({
      id: "dev.firefly.runtime",
      name: "运行时插件",
      tools: [{ name: "exec_task", title: "执行插件任务", risk: ["shell"], modes: ["work"] }],
    });
    const hostCall = vi.fn(async () => ({ status: "succeeded", output: "done" }));
    service.registerTool({
      manifest,
      registration: {
        name: "exec_task",
        description: "Run plugin shell task",
        parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
      },
      host: { call: hostCall },
    });

    const toolId = pluginToolId(manifest.id, "exec_task");
    const toolDef = registry.getById(toolId)!;
    setCurrentLevel("read-only");

    const controller = new AbortController();
    const runtime = prepareToolRuntime({
      sendBaseEvent: vi.fn(),
      signal: controller.signal,
      options: {
        messages: [{ role: "user", content: "run" }],
        conversationMode: "work",
        executionMode: "work",
        conversationId: "conv-rt",
        runId: "run-rt",
        timeoutMs: 10_000,
        toolSystemContent: "",
        soulSystemBaseContent: "",
        settings: { provider: "OpenAI", baseUrl: "https://example.invalid", model: "m", apiKey: "k", contextWindowTokens: 64_000 },
        tools: [toolDef],
      },
      prepared: {
        threadId: "conv-rt",
        runId: "run-rt",
        messageId: "msg-rt",
        planState: undefined,
        vendorConfig: { provider: "OpenAI", baseUrl: "https://example.invalid", model: "m", apiKey: "k", explicitTransport: "openai" },
        tools: [toolDef],
        promptLayers: { stablePrefix: "", mode: "work" },
        agentLoopPromptLayers: { stablePrefix: "", mode: "work" },
        systemPrompt: "",
        runMessages: [{ role: "user", content: "run" }],
        runStore: {} as never,
      },
    });

    const pending = runtime.checkPermission(
      toolId,
      { task: "build" },
      controller.signal,
      { agentId: "ops-release", agentName: "帕姆", toolCallId: "tc-rt-1" },
    );

    await vi.waitFor(() => {
      expect(mockElectron.sent.some((e) => e.channel === IPC.PERMISSION_APPROVAL_REQUEST)).toBe(true);
    });
    const req = mockElectron.sent.find((e) => e.channel === IPC.PERMISSION_APPROVAL_REQUEST)!.payload as {
      id: string;
      declaredBy?: string;
      agentId?: string;
      agentName?: string;
      risks?: string[];
    };
    expect(req.declaredBy).toBe("运行时插件");
    expect(req.agentId).toBe("ops-release");
    expect(req.agentName).toBe("帕姆");
    expect(req.risks).toEqual(["shell"]);

    answerApproval(req.id, false);
    expect(await pending).toBe(false);
    expect(hostCall).not.toHaveBeenCalled();
  });

  it("settles post-dispatch timeout, mid-execution cancellation, and ERR_UNAVAILABLE as unknown, while pre-dispatch abort settles as not_executed", async () => {
    const [hostTransport, pluginTransport] = createPairedTransports();
    const hostRpc = createRpcEndpoint(hostTransport);
    const pluginRpc = createRpcEndpoint(pluginTransport);
    const registry = new ToolRegistry();
    const service = createPluginToolService({ registry, defaultTimeoutMs: 40 });
    const manifest = makeManifest({
      id: "dev.firefly.lifecycle",
      name: "生命周期插件",
      tools: [{ name: "send_notice", title: "发送通知", risk: ["network"], modes: ["work"] }],
    });

    const host: PluginToolExecuteHost = {
      call: (_id, method, params, opts) => hostRpc.call(method, params, opts),
    };
    service.bindRpc(manifest, hostRpc, host);

    const stopController = new AbortController();
    const { ctx, awaitPendingRegistrations } = createPluginContextProxy({
      id: manifest.id,
      version: manifest.version,
      dataDir: "C:\\tmp\\plugin-data",
      permissions: [],
      signal: stopController.signal,
      rpc: pluginRpc,
    });

    let started = false;
    let markStarted: (() => void) | undefined;
    let releaseCall!: () => void;
    const executeSpy = vi.fn(async (args: Record<string, unknown>) => {
      started = true;
      markStarted?.();
      if (args.mode === "hang") {
        await new Promise<void>((resolve) => {
          releaseCall = resolve;
        });
      }
      return { status: "succeeded", output: "sent" };
    });

    ctx.tools.register({
      name: "send_notice",
      description: "Send notice",
      parameters: { type: "object", properties: { mode: { type: "string" } }, required: ["mode"] },
      execute: executeSpy,
    });
    await awaitPendingRegistrations();

    const toolId = pluginToolId(manifest.id, "send_notice");
    const toolDef = registry.getById(toolId)!;

    // 1. Pre-dispatch cancellation -> not_executed AND plugin handler is NOT called.
    const preAborted = new AbortController();
    preAborted.abort();
    const directPreAbort = await service.executeTool(
      manifest.id,
      "send_notice",
      { mode: "ok" },
      { mode: "work", signal: preAborted.signal },
    );
    expect(directPreAbort).toMatchObject({ status: "not_executed", reason: expect.stringContaining("ERR_CANCELLED") });

    const preAbortState = makeState();
    const dispatchedPreAbort = await dispatchToolCall(
      { id: "tc-pre-abort", name: toolId, arguments: JSON.stringify({ mode: "ok" }) },
      {
        state: preAbortState,
        tools: [toolDef],
        toolContext: { userQuery: "send", mode: "work", runId: "run-pre", conversationId: "sess-1", signal: preAborted.signal },
      },
    );
    expect(dispatchedPreAbort.outcome).toBe("not_executed");
    expect(preAbortState.uncertainEffects).toHaveLength(0);
    expect(executeSpy).not.toHaveBeenCalled();

    // 2. Timeout while plugin is mid-execution -> unknown (effectState: "unknown").
    started = false;
    const timeoutState = makeState();
    const dispatchedTimeout = await dispatchToolCall(
      { id: "tc-timeout", name: toolId, arguments: JSON.stringify({ mode: "hang" }) },
      {
        state: timeoutState,
        tools: [toolDef],
        toolContext: { userQuery: "send", mode: "work", runId: "run-timeout", conversationId: "sess-1" },
      },
    );
    expect(started).toBe(true);
    expect(dispatchedTimeout.outcome).toBe("unknown");
    expect(dispatchedTimeout.rawResult?.effectState).toBe("unknown");
    expect(dispatchedTimeout.message).toContain("ERR_TIMEOUT");
    expect(timeoutState.uncertainEffects).toHaveLength(1);
    releaseCall?.();

    // 3. Mid-execution cancellation -> unknown (effectState: "unknown").
    const cancelService = createPluginToolService({ registry: new ToolRegistry(), defaultTimeoutMs: 5_000 });
    cancelService.registerTool({
      manifest,
      registration: {
        name: "send_notice",
        description: "Send notice",
        parameters: { type: "object", properties: { mode: { type: "string" } }, required: ["mode"] },
      },
      host,
      timeoutMs: 5_000,
    });
    const cancelToolDef = cancelService;
    void cancelToolDef;
    started = false;
    executeSpy.mockClear();
    const startedPromise = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const midAbort = new AbortController();
    const cancelState = makeState();
    const pendingCancel = cancelService.executeTool(
      manifest.id,
      "send_notice",
      { mode: "hang" },
      { mode: "work", signal: midAbort.signal, timeoutMs: 5_000 },
    );
    await startedPromise;
    expect(started).toBe(true);
    midAbort.abort();
    const midCancelResult = await pendingCancel;
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(midCancelResult).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("ERR_CANCELLED"),
    });
    releaseCall?.();

    // Also verify mid-execution cancellation through dispatchToolCall -> outcome: "unknown" & uncertainEffects populated.
    started = false;
    executeSpy.mockClear();
    const dispatchRegistry = new ToolRegistry();
    const dispatchCancelService = createPluginToolService({ registry: dispatchRegistry, defaultTimeoutMs: 5_000 });
    dispatchCancelService.registerTool({
      manifest,
      registration: {
        name: "send_notice",
        description: "Send notice",
        parameters: { type: "object", properties: { mode: { type: "string" } }, required: ["mode"] },
      },
      host,
      timeoutMs: 5_000,
    });
    const startedPromise2 = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const midAbort2 = new AbortController();
    const pendingDispatchCancel = dispatchToolCall(
      { id: "tc-mid-cancel", name: toolId, arguments: JSON.stringify({ mode: "hang" }) },
      {
        state: cancelState,
        tools: [dispatchRegistry.getById(toolId)!],
        toolContext: { userQuery: "send", mode: "work", runId: "run-cancel", conversationId: "sess-1", signal: midAbort2.signal },
      },
    );
    await startedPromise2;
    midAbort2.abort();
    const dispatchedMidCancel = await pendingDispatchCancel;
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(dispatchedMidCancel.outcome).toBe("unknown");
    expect(dispatchedMidCancel.rawResult?.effectState).toBe("unknown");
    expect(dispatchedMidCancel.message).toContain("ERR_CANCELLED");
    expect(cancelState.uncertainEffects).toHaveLength(1);
    releaseCall?.();

    // 4. Post-dispatch ERR_UNAVAILABLE -> unknown.
    const unavailableService = createPluginToolService({ registry: new ToolRegistry() });
    unavailableService.registerTool({
      manifest,
      registration: {
        name: "send_notice",
        description: "Send notice",
        parameters: { type: "object", properties: { mode: { type: "string" } }, required: ["mode"] },
      },
      host: {
        call: async () => {
          throw new PluginError("ERR_UNAVAILABLE", "Plugin process disappeared");
        },
      },
    });
    const unavailableRes = await unavailableService.executeTool(manifest.id, "send_notice", { mode: "ok" }, { mode: "work" });
    expect(unavailableRes).toMatchObject({ status: "unknown", reason: expect.stringContaining("ERR_UNAVAILABLE") });

    hostRpc.dispose();
    pluginRpc.dispose();
  });
});

describe("G37 Plugin tools: parameter schemas and explicit results", () => {
  it("inlines local $defs references so the model spec has no dangling $ref, and still validates through them", async () => {
    const registry = new ToolRegistry();
    const service = createPluginToolService({ registry });
    const host: PluginToolExecuteHost = { call: vi.fn(async () => ({ status: "succeeded", output: "ok" })) };
    const manifest = makeManifest();
    service.registerTool({
      manifest,
      registration: {
        name: "get_weather",
        description: "Query weather",
        parameters: {
          type: "object",
          properties: { place: { $ref: "#/$defs/Place", description: "where" } },
          required: ["place"],
          $defs: { Place: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
        },
      },
      host,
    });
    const definition = registry.getById(pluginToolId(manifest.id, "get_weather"))!;
    expect(definition.inputSchema).toEqual({
      type: "object",
      properties: {
        place: { type: "object", properties: { city: { type: "string" } }, required: ["city"], description: "where" },
      },
      required: ["place"],
    });
    expect(JSON.stringify(definition.inputSchema)).not.toContain("$ref");
    expect(await service.executeTool(manifest.id, "get_weather", { place: {} }, { mode: "work" })).toMatchObject({
      status: "not_executed",
      reason: expect.stringContaining("ERR_INVALID_ARGUMENT"),
    });
    expect(host.call).not.toHaveBeenCalled();
  });

  it.each([
    ["a remote $ref", { type: "object", properties: { a: { $ref: "https://example.com/schema.json" } } }],
    ["a missing local $ref", { type: "object", properties: { a: { $ref: "#/$defs/Missing" } } }],
    ["a recursive $ref", {
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: { Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } } },
    }],
    ["an $async schema", { $async: true, type: "object", properties: { a: { type: "string" } } }],
  ])("refuses parameters with %s at registration and registers nothing", (_label, parameters) => {
    const registry = new ToolRegistry();
    const service = createPluginToolService({ registry });
    const host: PluginToolExecuteHost = { call: vi.fn() };
    expect(() => service.registerTool({
      manifest: makeManifest(),
      registration: { name: "get_weather", description: "Query weather", parameters },
      host,
    })).toThrow(expect.objectContaining({ name: "PluginError", code: "ERR_INVALID_ARGUMENT" }));
    expect(registry.getAllTools()).toHaveLength(0);
  });

  it("keeps a succeeded plugin result succeeded even when its output looks like a legacy failure payload", async () => {
    const registry = new ToolRegistry();
    const service = createPluginToolService({ registry });
    const output = { success: false, error: "remote job failed", timedOut: true, jobId: "j-1" };
    const host: PluginToolExecuteHost = { call: vi.fn(async () => ({ status: "succeeded", output })) };
    const manifest = makeManifest();
    service.registerTool({
      manifest,
      registration: { name: "get_weather", description: "Query weather", parameters: { type: "object", properties: {} } },
      host,
    });
    const definition = registry.getById(pluginToolId(manifest.id, "get_weather"))!;
    const outcome = await executeToolDefinition(definition, {}, { mode: "work" });
    expect(outcome).toMatchObject({ status: "succeeded" });
    expect(JSON.parse(outcome.output)).toEqual(output);
  });
});
