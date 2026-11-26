import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginScheduleService } from "../../../../plugins/v2/schedules";
import type { ScheduleProposalSpec } from "../../../../plugins/v2/schedules/types";
import { createSchedulerStore } from "../../scheduler/scheduler-store";
import { ToolRegistry, type ToolDefinition } from "../../../tooling/registry/tool-registry";
import { createPluginTaskRiskResolver } from "./plugin-task-risks";

vi.mock("electron", () => ({ app: { getPath: () => { throw Error("real profile forbidden"); } }, ipcMain: {} }));

const NOW = new Date("2032-03-10T10:00:00.000Z");
const PLUGIN = "dev.firefly.digest";

function tool(id: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id, name: id, description: id, enabled: true, execute: async () => "",
    inputSchema: { type: "object", properties: {} }, ...extra,
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(tool("run_shell", { risk: "shell" }));
  registry.register(tool("read_note", { risk: "safe" }));
  registry.register(tool("untagged"));
  registry.register(tool("plugin_tool", { risks: ["network", "fs-write"] }));
  return registry;
}

describe("createPluginTaskRiskResolver", () => {
  const resolve = createPluginTaskRiskResolver(makeRegistry());

  it.each([
    { name: "shell tool", ids: ["run_shell"], expected: ["shell"] },
    { name: "safe and untagged tools carry no risk", ids: ["read_note", "untagged"], expected: [] },
    { name: "multi-risk plugin tool", ids: ["plugin_tool"], expected: ["network", "fs-write"] },
    { name: "unknown tool counts as shell", ids: ["not_registered"], expected: ["shell"] },
    { name: "empty allowlist", ids: [], expected: [] },
  ])("$name", ({ ids, expected }) => {
    expect(resolve({ allowedToolIds: ids }).sort()).toEqual([...expected].sort());
  });

  it("without a registry every allowed tool counts as shell", () => {
    expect(createPluginTaskRiskResolver(undefined)({ allowedToolIds: ["read_note"] })).toEqual(["shell"]);
  });
});

describe("plugin schedule with the real risk resolver", () => {
  let workdir: string;
  let counter: number;
  beforeEach(() => { workdir = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-task-risks-")); counter = 0; });
  afterEach(() => fs.rmSync(workdir, { recursive: true, force: true }));

  /** Confirms the task while its tools look safe, then lets `resolveTaskRisks` decide at fire time (the registry changed since). */
  async function setup(spec: Partial<ScheduleProposalSpec>, resolveTaskRisks = createPluginTaskRiskResolver(makeRegistry()), confirmWith: typeof resolveTaskRisks | null = () => []) {
    let active = confirmWith ?? resolveTaskRisks;
    const store = createSchedulerStore({
      tasksFile: path.join(workdir, "scheduled-tasks.json"),
      historyFile: path.join(workdir, "scheduled-tasks-history.jsonl"),
      now: () => NOW,
      id: () => `store-task-${counter++}`,
    });
    store.load();
    const runAgentTask = vi.fn(async () => ({ ok: true, historyId: "h", effectiveToolIds: [] as string[] }));
    const service = createPluginScheduleService({
      store,
      stateFile: path.join(workdir, "state.json"),
      now: () => NOW,
      id: () => `id-${counter++}`,
      runAgentTask,
      resolveTaskRisks: (task) => active(task),
    });
    const proposed = await service.forPlugin(PLUGIN).propose({
      title: "Digest",
      schedule: { kind: "interval", minutes: 30 },
      action: { type: "run", prompt: "Do it", mode: "work" },
      ...spec,
    });
    service.confirmProposal(proposed.taskId);
    active = resolveTaskRisks;
    return { service, store, runAgentTask, task: store.getTasks()[0]! };
  }

  it.each([
    { name: "run_shell with no declared requiredRisks", tools: ["run_shell"] },
    { name: "an unknown tool id", tools: ["ghost_tool"] },
  ])("a task with $name is refused at confirmation and nothing is saved", async ({ tools }) => {
    await expect(setup({ allowedToolIds: tools }, undefined, null)).rejects.toMatchObject({
      code: "ERR_PERMISSION", reason: "unattended_approval_unsupported",
    });
    const tasksFile = path.join(workdir, "scheduled-tasks.json");
    expect(fs.existsSync(tasksFile) ? fs.readFileSync(tasksFile, "utf8") : "").not.toContain("Digest");
  });

  it("a scheduled fire whose tools became privileged after confirmation runs nothing and leaves no pending approval", async () => {
    const { service, store, runAgentTask, task } = await setup({ allowedToolIds: ["run_shell"] });
    const result = await service.runScheduledTask(task, NOW, false);
    expect(result).toMatchObject({ ok: false, error: "unattended run needs approval (not supported in 1.2.0)" });
    expect(runAgentTask).not.toHaveBeenCalled();
    expect(service.listPendingRunApprovals(PLUGIN)).toHaveLength(0);
    expect(store.getTasks()[0]?.pluginUserEnabled).toBe(false);
  });

  it("a safe-only allowlist still runs unattended", async () => {
    const { service, runAgentTask, task } = await setup({ allowedToolIds: ["read_note"] });
    const result = await service.runScheduledTask(task, NOW, false);
    expect(result.ok).toBe(true);
    expect(runAgentTask).toHaveBeenCalledTimes(1);
    expect(service.listPendingRunApprovals(PLUGIN)).toHaveLength(0);
  });

  it("a resolver that throws fails closed: the fire runs nothing and leaves no pending approval", async () => {
    const { service, runAgentTask, task } = await setup({ allowedToolIds: ["read_note"] }, () => { throw new Error("registry broken"); });
    const result = await service.runScheduledTask(task, NOW, false);
    expect(result).toMatchObject({ ok: false, error: "unattended run needs approval (not supported in 1.2.0)" });
    expect(runAgentTask).not.toHaveBeenCalled();
    expect(service.listPendingRunApprovals(PLUGIN)).toHaveLength(0);
  });
});
