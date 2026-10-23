import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { userDataRoot, cleanupUserData } = await vi.hoisted(async () => {
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-mcp-effect-permission-"));
  return {
    userDataRoot: root,
    cleanupUserData: () => fs.rmSync(root, { recursive: true, force: true }),
  };
});

afterAll(cleanupUserData);

const { connect, listTools, callTool, close, send, handlers } = vi.hoisted(() => ({
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
  send: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(function () { return { connect, listTools, callTool, close }; }),
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(function () { return { close }; }),
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn(function () { return { close }; }),
}));
vi.mock("electron", () => ({
  app: { getPath: () => userDataRoot },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send } }] },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => handlers.set(channel, listener),
  },
}));
vi.mock("fs", () => ({ mkdirSync: vi.fn(), writeFileSync: vi.fn() }));
vi.mock("../rag/index", () => ({ searchMemory: vi.fn() }));
vi.mock("../tasks/task-session-store", () => ({ TaskSessionStore: class {} }));
vi.mock("./harness/tool-output/file-tool-output-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("./harness/tool-output/file-tool-output-store")>(),
  FileToolOutputStore: class {},
}));

import { IPC } from "../../shared/ipc-channels";
import type { ApprovalRequest } from "../../shared/permission-approval";
import { cancelPendingApprovalsForRun, registerPermissionIpc, setCurrentLevel } from "../permission";
import { policyFor, type AgentFileAccessLevel, type ToolRiskLevel } from "../permission-policy";
import { connectMcpServer, disconnectMcpServer } from "./mcp-adapter";
import { ExecutionLedger } from "./execution-ledger";
import type { FireflyRunOptions } from "./firefly-agent";
import { prepareToolRuntime } from "./harness/adapter/tool-runtime";
import type { PreparedHarnessRun } from "./harness/adapter/run-preparation";
import { dispatchToolCall, type ToolDispatchContext } from "./harness/tool-dispatcher";
import { resolveSideEffect } from "./harness/side-effect-resolver";
import { resolveUncertainEffect } from "./harness/uncertain-effect-guard";
import { enterPlanDiscussing, resetPlanSessionsForTest } from "./plan-mode";
import { toolRegistry, type ToolDefinition, type ToolEffectKind } from "./tools/registry/tool-registry";

type Annotations = { readOnlyHint?: boolean; destructiveHint?: boolean };

interface EffectCase {
  label: string;
  annotations?: Annotations;
  override?: ToolEffectKind;
  effect: ToolEffectKind;
  risk: ToolRiskLevel;
}

const effectCases: EffectCase[] = [
  { label: "missing annotations", effect: "unknown", risk: "input-control" },
  { label: "destructiveHint=false alone", annotations: { destructiveHint: false }, effect: "unknown", risk: "input-control" },
  { label: "untrusted read-only hint", annotations: { readOnlyHint: true }, effect: "unknown", risk: "input-control" },
  { label: "untrusted read-only and non-destructive hints", annotations: { readOnlyHint: true, destructiveHint: false }, effect: "unknown", risk: "input-control" },
  { label: "destructive annotation", annotations: { destructiveHint: true }, effect: "external_side_effect", risk: "input-control" },
  { label: "contradictory annotations", annotations: { readOnlyHint: true, destructiveHint: true }, effect: "external_side_effect", risk: "input-control" },
  { label: "local read overrides destructive annotation", annotations: { readOnlyHint: true, destructiveHint: true }, override: "read", effect: "read", risk: "network" },
  { label: "local verification", annotations: { destructiveHint: true }, override: "verification", effect: "verification", risk: "network" },
  { label: "local mutation overrides read annotation", annotations: { readOnlyHint: true }, override: "mutation", effect: "mutation", risk: "fs-write" },
  { label: "local external effect overrides read annotation", annotations: { readOnlyHint: true }, override: "external_side_effect", effect: "external_side_effect", risk: "input-control" },
  { label: "local unknown overrides read annotation", annotations: { readOnlyHint: true }, override: "unknown", effect: "unknown", risk: "input-control" },
];

let approvalRequests: ApprovalRequest[];

async function registerMcp(annotations?: Annotations, override?: ToolEffectKind): Promise<ToolDefinition> {
  listTools.mockResolvedValue({ tools: [{
    name: "explode",
    description: "MCP effect fixture",
    annotations,
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  }] });
  const registeredIds = await connectMcpServer({
    id: "test-error",
    name: "Test Error",
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    effectKindOverrides: override === undefined ? undefined : { explode: override },
  });
  expect(registeredIds).toEqual(["test-error-explode"]);
  const tool = toolRegistry.getById("test-error-explode");
  if (!tool) throw new Error("MCP fixture was not registered");
  return tool;
}

function dispatchContext(permissionMode: FireflyRunOptions["permissionMode"] = "normal"): ToolDispatchContext {
  const tools = toolRegistry.getAllTools();
  const runtime = prepareToolRuntime({
    options: {
      conversationId: "thread-1",
      conversationMode: "chat",
      settings: { provider: "test", baseUrl: "", model: "model", apiKey: "", contextWindowTokens: 1000 },
      timeoutMs: 1000,
      messages: [{ role: "user", content: "MCP effect fixture" }],
      permissionMode,
    },
    signal: new AbortController().signal,
    prepared: { threadId: "thread-1", runId: "run-1", systemPrompt: "system", tools } as PreparedHarnessRun,
    sendBaseEvent: vi.fn(),
  });
  return {
    state: { todoItems: [], uncertainEffects: [] },
    tools,
    checkPermission: runtime.checkPermission,
    toolContext: runtime.toolContext,
    executionLedger: new ExecutionLedger(),
  };
}

function call(id: string, value = "x", name = "test-error-explode") {
  return { id, name, arguments: JSON.stringify({ value }) };
}

function answerApproval(allowed: boolean): void {
  const request = approvalRequests.at(-1);
  const resolve = handlers.get(IPC.PERMISSION_APPROVAL_RESOLVE);
  if (request && resolve) resolve(undefined, { id: request.id, allowed });
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  approvalRequests = [];
  send.mockImplementation((channel: string, payload: ApprovalRequest) => {
    if (channel === IPC.PERMISSION_APPROVAL_REQUEST) approvalRequests.push(payload);
  });
  connect.mockResolvedValue(undefined);
  close.mockResolvedValue(undefined);
  listTools.mockReset();
  callTool.mockReset().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  for (const tool of toolRegistry.getAllTools()) toolRegistry.unregister(tool.id);
  resetPlanSessionsForTest();
  registerPermissionIpc();
});

afterEach(async () => {
  cancelPendingApprovalsForRun("run-1");
  await disconnectMcpServer("test-error");
  for (const tool of toolRegistry.getAllTools()) toolRegistry.unregister(tool.id);
  resetPlanSessionsForTest();
  setCurrentLevel("read-only");
});

describe("MCP registration through host permission and dispatcher", () => {
  it.each(effectCases)("per-action denial prevents execution: $label", async ({ annotations, override, effect, risk }) => {
    setCurrentLevel("per-action");
    const tool = await registerMcp(annotations, override);
    const context = dispatchContext();
    const pending = dispatchToolCall(call("call-1"), context);
    expect(callTool).not.toHaveBeenCalled();
    answerApproval(false);
    const result = await pending;

    expect(result).toMatchObject({ outcome: "failure", category: "permission_denied" });
    expect(tool).toMatchObject({ effectKind: effect, risk });
    expect(policyFor("per-action", risk)).toBe("ask");
    expect(approvalRequests).toEqual([expect.objectContaining({
      toolId: tool.id, risk, runId: "run-1", args: { value: "x" },
    })]);
    expect(callTool).not.toHaveBeenCalled();
    expect(context.state.uncertainEffects).toEqual([]);
  });

  it.each(["read", "verification"] as const)("read-only allows explicit %s MCP invocation", async (effect) => {
    setCurrentLevel("read-only");
    await registerMcp({ destructiveHint: true }, effect);
    const context = dispatchContext();
    const result = await dispatchToolCall(call("call-1"), context);

    expect(result).toMatchObject({ outcome: "success", output: "ok", toolSideEffect: "read_only" });
    expect(callTool).toHaveBeenCalledExactlyOnceWith(
      { name: "explode", arguments: { value: "x" } }, undefined, { signal: context.toolContext.signal },
    );
    expect(approvalRequests).toEqual([]);
    expect(context.state.uncertainEffects).toEqual([]);
  });

  it.each(["read-only", "project-read-only", "scoped"] as const)("%s denies a server-asserted read-only MCP tool", async (level) => {
    setCurrentLevel(level);
    const tool = await registerMcp({ readOnlyHint: true, destructiveHint: false });
    const result = await dispatchToolCall(call("call-1"), dispatchContext());

    expect(tool).toMatchObject({ effectKind: "unknown", risk: "input-control" });
    expect(result).toMatchObject({ outcome: "failure", category: "permission_denied" });
    expect(callTool).not.toHaveBeenCalled();
    expect(approvalRequests).toEqual([]);
  });

  it("invalid persisted effect override cannot leave MCP risk unset", async () => {
    setCurrentLevel("per-action");
    const tool = await registerMcp({ readOnlyHint: true }, "invalid_effect_kind" as ToolEffectKind);
    const pending = dispatchToolCall(call("call-1"), dispatchContext());
    expect(callTool).not.toHaveBeenCalled();
    answerApproval(false);

    expect(await pending).toMatchObject({ outcome: "failure", category: "permission_denied" });
    expect(tool).toMatchObject({ effectKind: "unknown", risk: "input-control" });
    expect(approvalRequests).toHaveLength(1);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("a server tool name cannot read an inherited effect override", async () => {
    setCurrentLevel("per-action");
    listTools.mockResolvedValue({ tools: [{
      name: "constructor",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: {} },
    }] });
    await connectMcpServer({
      id: "test-error", name: "Test Error", transport: "stdio", command: "node", args: ["server.js"],
      effectKindOverrides: {},
    });
    const tool = toolRegistry.getById("test-error-constructor");
    const pending = dispatchToolCall(call("call-1", "x", "test-error-constructor"), dispatchContext());
    expect(callTool).not.toHaveBeenCalled();
    answerApproval(false);

    expect(await pending).toMatchObject({ outcome: "failure", category: "permission_denied" });
    expect(tool).toMatchObject({ effectKind: "unknown", risk: "input-control" });
    expect(approvalRequests).toHaveLength(1);
    expect(callTool).not.toHaveBeenCalled();
  });

  it.each(["read-only", "project-read-only"] as const)("%s denies mutation, external and unknown MCP without execution", async (level) => {
    setCurrentLevel(level);
    for (const effect of ["mutation", "external_side_effect", "unknown"] as const) {
      await registerMcp(undefined, effect);
      const context = dispatchContext();
      const result = await dispatchToolCall(call("call-1"), context);
      expect(result).toMatchObject({ outcome: "failure", category: "permission_denied" });
      expect(context.state.uncertainEffects).toEqual([]);
      await disconnectMcpServer("test-error");
    }
    expect(callTool).not.toHaveBeenCalled();
    expect(approvalRequests).toEqual([]);
  });

  it("plan read-only denies unknown MCP even at full access", async () => {
    setCurrentLevel("full");
    enterPlanDiscussing("thread-1");
    await registerMcp();
    const result = await dispatchToolCall(call("call-1"), dispatchContext());
    expect(result).toMatchObject({ outcome: "failure", category: "permission_denied" });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("per-action approval permits the explicitly approved unknown MCP call", async () => {
    setCurrentLevel("per-action");
    await registerMcp();
    const context = dispatchContext();
    const pending = dispatchToolCall(call("call-1"), context);
    expect(callTool).not.toHaveBeenCalled();
    answerApproval(true);
    expect(await pending).toMatchObject({ outcome: "success", output: "ok" });
    expect(approvalRequests).toHaveLength(1);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(context.state.uncertainEffects).toEqual([]);
  });

  it.each(["mutation", "external_side_effect", "unknown"] as const)("plan read-only denies %s even with explicit allow_all", async (effect) => {
    setCurrentLevel("read-only");
    enterPlanDiscussing("thread-1");
    await registerMcp(undefined, effect);
    const context = dispatchContext("allow_all");
    expect(await dispatchToolCall(call("call-1"), context)).toMatchObject({ outcome: "failure", category: "permission_denied" });
    expect(callTool).not.toHaveBeenCalled();
    expect(approvalRequests).toEqual([]);
    expect(context.state.uncertainEffects).toEqual([]);
  });

  it.each(["mutation", "external_side_effect", "unknown"] as const)("explicit allow_all preserves %s execution outside plan read-only", async (effect) => {
    setCurrentLevel("read-only");
    await registerMcp(undefined, effect);
    const context = dispatchContext("allow_all");
    expect(await dispatchToolCall(call("call-1"), context)).toMatchObject({ outcome: "success", output: "ok" });
    expect(callTool).toHaveBeenCalledExactlyOnceWith(
      { name: "explode", arguments: { value: "x" } }, undefined, { signal: context.toolContext.signal },
    );
    expect(approvalRequests).toEqual([]);
    expect(context.state.uncertainEffects).toEqual([]);
  });

  it.each(["read", "verification"] as const)("plan read-only allows trusted %s MCP with explicit allow_all", async (effect) => {
    setCurrentLevel("read-only");
    enterPlanDiscussing("thread-1");
    await registerMcp(undefined, effect);
    const context = dispatchContext("allow_all");
    expect(await dispatchToolCall(call("call-1"), context)).toMatchObject({ outcome: "success", output: "ok", toolSideEffect: "read_only" });
    expect(callTool).toHaveBeenCalledExactlyOnceWith(
      { name: "explode", arguments: { value: "x" } }, undefined, { signal: context.toolContext.signal },
    );
    expect(approvalRequests).toEqual([]);
    expect(context.state.uncertainEffects).toEqual([]);
  });

  it.each(["scoped", "full"] as const)("%s preserves mutation admission", async (level) => {
    setCurrentLevel(level);
    await registerMcp(undefined, "mutation");
    expect(await dispatchToolCall(call("call-1"), dispatchContext())).toMatchObject({ outcome: "success" });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(approvalRequests).toEqual([]);
  });

  it("scoped denies external and unknown MCP", async () => {
    setCurrentLevel("scoped");
    for (const effect of ["external_side_effect", "unknown"] as const) {
      await registerMcp(undefined, effect);
      expect(await dispatchToolCall(call("call-1"), dispatchContext())).toMatchObject({ outcome: "failure", category: "permission_denied" });
      await disconnectMcpServer("test-error");
    }
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe("MCP uncertain effects", () => {
  it("an approved unknown MCP failure blocks a new call before requesting another approval", async () => {
    setCurrentLevel("per-action");
    await registerMcp();
    callTool.mockRejectedValue(new Error("remote tool failed"));
    const context = dispatchContext();
    const pending = dispatchToolCall(call("call-old"), context);
    answerApproval(true);
    expect(await pending).toMatchObject({ outcome: "unknown" });
    expect(context.state.uncertainEffects).toHaveLength(1);
    expect(await dispatchToolCall(call("call-new"), context)).toMatchObject({ outcome: "not_executed", category: "runtime_safety" });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(approvalRequests).toHaveLength(1);
  });

  it.each(["unknown", "external_side_effect"] as const)("%s transport error records uncertainty and blocks a new logical invocation", async (effect) => {
    setCurrentLevel("full");
    await registerMcp(undefined, effect);
    callTool.mockRejectedValueOnce(new Error("remote tool failed")).mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const context = dispatchContext();
    const first = await dispatchToolCall(call("call-old"), context);

    expect(first).toMatchObject({ outcome: "unknown", toolSideEffect: "non_idempotent_side_effect", retryDecision: "no_retry" });
    expect(first.rawResult).toMatchObject({ status: "failed", errorCode: "E_MCP_TOOL_FAILED", effectState: "unknown" });
    expect(context.state.uncertainEffects).toEqual([expect.objectContaining({
      id: "run-1:call-old", toolCallId: "call-old", fingerprint: "test-error-explode(value=x)", toolName: "test-error-explode",
    })]);
    expect(await dispatchToolCall(call("call-new"), context)).toMatchObject({ outcome: "not_executed", category: "runtime_safety" });
    expect(callTool).toHaveBeenCalledTimes(1);

    expect(await dispatchToolCall(call("call-different", "other"), context)).toMatchObject({ outcome: "success" });
    expect(callTool).toHaveBeenCalledTimes(2);
    resolveUncertainEffect(context.state, "call-old");
    expect(await dispatchToolCall(call("call-approved"), context)).toMatchObject({ outcome: "success" });
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(context.state.uncertainEffects).toEqual([]);
  });

  it("MCP isError also retains unknown effects and blocks replay under allow_all", async () => {
    setCurrentLevel("read-only");
    await registerMcp();
    callTool.mockResolvedValue({ isError: true, content: [{ type: "text", text: "remote tool failed" }] });
    const context = dispatchContext("allow_all");
    expect(await dispatchToolCall(call("call-old"), context)).toMatchObject({ outcome: "unknown" });
    expect(context.state.uncertainEffects).toHaveLength(1);
    expect(await dispatchToolCall(call("call-new"), context)).toMatchObject({ outcome: "not_executed", category: "runtime_safety" });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(approvalRequests).toEqual([]);
  });

  it.each(["read", "verification", "mutation"] as const)("failed explicit %s retains its existing replay classification", async (effect) => {
    setCurrentLevel("full");
    await registerMcp(undefined, effect);
    callTool.mockRejectedValue(new Error("remote tool failed"));
    const context = dispatchContext();
    expect(await dispatchToolCall(call("call-old"), context)).toMatchObject({ outcome: "failure", retryDecision: "no_retry" });
    expect(await dispatchToolCall(call("call-new"), context)).toMatchObject({ outcome: "failure" });
    expect(context.state.uncertainEffects).toEqual([]);
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it.each(["read-only", "per-action"] as AgentFileAccessLevel[])("%s still admits safe metadata reads with unknown effect bookkeeping", async (level) => {
    setCurrentLevel(level);
    const execute = vi.fn(async () => "Skill instructions");
    toolRegistry.register({
      id: "invoke_skill", name: "调用 Skill", description: "读取 Skill 正文", enabled: true, risk: "safe",
      effectKind: "read", effectResolver: () => "unknown", inputSchema: { type: "object", properties: {} }, execute,
    });
    const context = dispatchContext();
    expect(await dispatchToolCall(call("call-1", "x", "invoke_skill"), context)).toMatchObject({ outcome: "success", output: "Skill instructions" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(resolveSideEffect(toolRegistry.getById("invoke_skill"), {})).toBe("non_idempotent_side_effect");
    expect(context.state.uncertainEffects).toEqual([]);
    expect(approvalRequests).toEqual([]);
  });
});
