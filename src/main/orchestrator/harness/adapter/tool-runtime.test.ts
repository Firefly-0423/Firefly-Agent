import { beforeEach, describe, expect, it, vi } from "vitest";

const { getById, checkPermission, getCurrentLevel, createAgentExecutor, taskStore, toolOutputStore } = vi.hoisted(() => ({
  getById: vi.fn(),
  checkPermission: vi.fn(),
  getCurrentLevel: vi.fn(() => "scoped"),
  createAgentExecutor: vi.fn(() => vi.fn()),
  taskStore: vi.fn(),
  toolOutputStore: vi.fn(),
}));

vi.mock("../../tools/registry/tool-registry", () => ({ toolRegistry: { getById } }));
vi.mock("../../../permission", () => ({ checkPermission, getCurrentLevel }));
vi.mock("../../persistent-agent-runtime", () => ({ createAgentExecutor }));
vi.mock("../../../settings/model-settings", () => ({ loadModelSettings: () => ({ modelProfiles: [], agentModelProfiles: {} }) }));
vi.mock("../../../tasks/task-session-store", () => ({ getTaskSessionStore: taskStore }));
vi.mock("../tool-output/file-tool-output-store", () => ({ FileToolOutputStore: toolOutputStore }));
vi.mock("./event-mapper", () => ({ sendTaskLifecycleAsAgui: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: vi.fn(() => "E:\\synthetic-firefly-runtime") } }));

import { prepareToolRuntime } from "./tool-runtime";
import { approvePlan, enterPlanDiscussing, markPlanWritten, moveToReview, resetPlanSessionsForTest } from "../../plan-mode";

function prepareRuntime(mode: "code" | "chat" | "work" = "code", permissionMode: "normal" | "allow_all" = "normal") {
  return prepareToolRuntime({
    options: { conversationId: "plan-runtime", conversationMode: mode, permissionMode,
      settings: { provider: "synthetic", baseUrl: "", model: "model", apiKey: "" },
      messages: [{ role: "user", content: "Inspect synthetic plan" }] } as never,
    signal: new AbortController().signal,
    prepared: { threadId: "plan-runtime", runId: "run-synthetic", systemPrompt: "system",
      vendorConfig: {}, tools: [], runStore: {} } as never,
    sendBaseEvent: vi.fn(),
  });
}

describe("harness tool runtime", () => {
  beforeEach(() => {
    getById.mockReset();
    getCurrentLevel.mockReset();
    getCurrentLevel.mockReturnValue("scoped");
    resetPlanSessionsForTest();
    checkPermission.mockReset();
    createAgentExecutor.mockClear();
    checkPermission.mockResolvedValue({ allowed: true });
    getById.mockReturnValue({
      id: "read_file",
      name: "Read File",
      description: "reads a file",
      risk: "safe",
    });
  });

  const planCases = (["code", "chat"] as const).flatMap(mode =>
    (["PLAN_DISCUSSING", "PLAN_REVIEW"] as const).flatMap(state =>
      (["normal", "allow_all"] as const).map(permissionMode => ({ mode, state, permissionMode })),
    ),
  );
  it.each(planCases)("blocks shell and writes in $mode $state even with $permissionMode", async ({ mode, state, permissionMode }) => {
    enterPlanDiscussing("plan-runtime");
    if (state === "PLAN_REVIEW") {
      markPlanWritten("plan-runtime");
      expect(moveToReview("plan-runtime")).toBe(true);
    }
    getCurrentLevel.mockReturnValue("full");
    const runtime = prepareRuntime(mode, permissionMode);
    getById.mockImplementation((id: string) => ({ id, name: id, description: "fixture",
      risk: id === "run_shell" ? "shell" : "fs-write" }));
    expect(await runtime.checkPermission("run_shell", { command: "echo changed > synthetic.txt" })).toBe(false);
    expect(await runtime.checkPermission("write_file", { path: "synthetic.txt", content: "changed" })).toBe(false);
    expect(checkPermission).not.toHaveBeenCalled();
  });

  it("applies live plan restrictions when planning starts after runtime preparation", async () => {
    getCurrentLevel.mockReturnValue("full");
    const runtime = prepareRuntime("code", "allow_all");
    getById.mockReturnValue({ id: "run_shell", risk: "shell" });
    expect(await runtime.checkPermission("run_shell", {})).toBe(true);
    enterPlanDiscussing("plan-runtime");
    expect(await runtime.checkPermission("run_shell", {})).toBe(false);
  });

  it("honors an existing parent plan state even when a child runtime reports Work mode", async () => {
    enterPlanDiscussing("plan-runtime");
    const runtime = prepareRuntime("work", "allow_all");
    getById.mockReturnValue({ id: "run_shell", risk: "shell" });
    expect(await runtime.checkPermission("run_shell", {})).toBe(false);
  });

  it("keeps dedicated reads subject to the current permission decision during planning", async () => {
    enterPlanDiscussing("plan-runtime");
    const runtime = prepareRuntime();
    getById.mockReturnValue({ id: "read_file", risk: "fs-read", name: "Read", description: "fixture" });
    expect(await runtime.checkPermission("read_file", {})).toBe(true);
    checkPermission.mockResolvedValueOnce({ allowed: false });
    expect(await runtime.checkPermission("read_file", {})).toBe(false);
  });

  it("allows approved execution under an explicitly full session", async () => {
    enterPlanDiscussing("plan-runtime");
    markPlanWritten("plan-runtime");
    expect(moveToReview("plan-runtime")).toBe(true);
    expect(approvePlan("plan-runtime")).toBe(true);
    getCurrentLevel.mockReturnValue("full");
    const runtime = prepareRuntime("code", "allow_all");
    getById.mockReturnValue({ id: "run_shell", risk: "shell" });
    expect(await runtime.checkPermission("run_shell", { command: "synthetic-write" })).toBe(true);
  });

  it("snapshots one trusted file-access level for the session and its child executor", () => {
    getCurrentLevel.mockReturnValue("read-only");
    const runtime = prepareRuntime();
    expect(runtime.toolContext).toHaveProperty("fileAccessLevel", "read-only");
    expect(createAgentExecutor).toHaveBeenLastCalledWith(expect.objectContaining({
      parent: expect.objectContaining({ fileAccessLevel: "read-only" }),
    }));
    expect(getCurrentLevel).toHaveBeenCalledTimes(1);
  });

  it("forwards the tool call and sub-agent origin into the approval request", async () => {
    getCurrentLevel.mockReturnValue("per-action");
    const runtime = prepareRuntime();
    getById.mockReturnValue({ id: "write_file", risk: "fs-write", name: "Write", description: "fixture" });

    await runtime.checkPermission("write_file", {}, undefined, { toolCallId: "call-1", agentId: "reviewer", childRunId: "child-1" });

    expect(checkPermission).toHaveBeenCalledWith(expect.objectContaining({
      origin: { toolCallId: "call-1", agentId: "reviewer", childRunId: "child-1" },
    }));
  });

  it("passes the session snapshot into normal permission checks after global permission changes", async () => {
    getCurrentLevel.mockReturnValue("per-action");
    const runtime = prepareRuntime();
    getCurrentLevel.mockReturnValue("full");
    getById.mockReturnValue({ id: "write_file", risk: "fs-write", name: "Write", description: "fixture" });
    expect(await runtime.checkPermission("write_file", {})).toBe(true);
    expect(checkPermission).toHaveBeenCalledWith(expect.objectContaining({ level: "per-action" }));
  });

  it("does not widen a read-only session when the global level later becomes full", async () => {
    getCurrentLevel.mockReturnValue("read-only");
    const runtime = prepareRuntime();
    getCurrentLevel.mockReturnValue("full");
    getById.mockReturnValue({ id: "write_file", risk: "fs-write", name: "Write", description: "fixture" });
    expect(await runtime.checkPermission("write_file", {})).toBe(false);
    expect(checkPermission).not.toHaveBeenCalled();
  });

  it("uses one signal for context, permission, and task execution", async () => {
    const controller = new AbortController();
    const clarify = vi.fn(async () => ({ answers: [] }));
    const runtime = prepareToolRuntime({
      options: {
        conversationId: "thread-1",
        conversationMode: "work",
        settings: { provider: "test", baseUrl: "", model: "model", apiKey: "" },
        messages: [{ role: "user", content: "读文件" }],
        requestUserClarification: clarify,
        permissionMode: "prompt",
      } as never,
      signal: controller.signal,
      prepared: {
        threadId: "thread-1",
        runId: "run-1",
        systemPrompt: "system",
        vendorConfig: {},
        tools: [],
        runStore: {},
      } as never,
      sendBaseEvent: vi.fn(),
    });

    expect(runtime.toolContext.signal).toBe(runtime.signal);
    expect(runtime.signal).not.toBe(controller.signal);
    await runtime.checkPermission("read_file", { path: "x" });
    expect(checkPermission).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      signal: runtime.signal,
    }));
    expect(runtime.agentExecutor).toBeDefined();
    expect(runtime).not.toHaveProperty("taskExecutor");
    expect(createAgentExecutor).toHaveBeenCalledWith(expect.objectContaining({
      parent: expect.objectContaining({ signal: runtime.signal }),
    }));
    expect(createAgentExecutor.mock.calls[0][0].profiles).toHaveLength(12);
  });
});

it("uses the canonical Main registry and injects the same coordinator into the child parent contract", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "firefly-runtime-coordinator-"));
  try {
    const prepare = (resolvedWorkspaceRoot: string, runId: string) => prepareToolRuntime({
      options: { conversationId: "synthetic-main", conversationMode: "work", resolvedWorkspaceRoot,
        settings: {}, messages: [] } as never,
      signal: new AbortController().signal,
      prepared: { threadId: "synthetic-main", runId, systemPrompt: "synthetic", vendorConfig: {}, tools: [], runStore: {} } as never,
      sendBaseEvent: vi.fn(),
    });
    const first = prepare(root, "main-a");
    const second = prepare(join(root, "."), "main-b");
    expect(second.toolContext.execution?.coordinator).toBe(first.toolContext.execution?.coordinator);
    expect(first.toolContext.execution?.scope).toMatchObject({ parentRunId: "main-a", childRunId: "main-a", agentId: "main" });
    expect(createAgentExecutor).toHaveBeenLastCalledWith(expect.objectContaining({ parent: expect.objectContaining({
      executionCoordinator: first.toolContext.execution?.coordinator,
      revalidateToolPermission: second.toolContext.revalidateToolPermission,
    }) }));
    expect(prepareRuntime("chat").agentExecutor).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("Main owner quiescence stops only its composite and external cancellation still propagates", () => {
  const external = new AbortController();
  const prepare = (runId: string) => prepareToolRuntime({
    options: { conversationMode: "work", messages: [], settings: {} } as never,
    signal: external.signal,
    prepared: { threadId: "synthetic-owner", runId, systemPrompt: "synthetic", vendorConfig: {}, tools: [], runStore: {} } as never,
    sendBaseEvent: vi.fn(),
  });
  const first = prepare("main-one");
  const second = prepare("main-two");
  first.quiesceExecution();
  expect(first.signal.aborted).toBe(true);
  expect(first.toolContext.signal).toBe(first.signal);
  expect(second.signal.aborted).toBe(false);
  expect(external.signal.aborted).toBe(false);
  external.abort();
  expect(second.signal.aborted).toBe(true);
});
