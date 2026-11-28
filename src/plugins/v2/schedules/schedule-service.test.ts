import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { AtomicJsonStore } from "../../../main/base/storage/atomic-json-store";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchedulerEngine } from "../../../main/features/scheduler/scheduler-engine";
import { computeExecutionSpecFingerprint } from "../../../main/features/scheduler/execution-spec";
import { createSchedulerStore } from "../../../main/features/scheduler/scheduler-store";
import type { ScheduledRunResult, ScheduledTask } from "../../../main/platform/schedule/schedule-types";
import {
  CALLBACK_LISTENER_UNAVAILABLE_REASON,
  createPluginScheduleService,
  PluginError,
  type ScheduleProposalSpec,
  type ToolRisk,
  type UnattendedApprovalNotification,
} from "./index";

const BASE_TIME = new Date("2032-03-10T10:00:00.000Z");

/** Fail the next write of the plugin schedule state file only (the task store uses the same writer class). */
function failNextPluginStateSave() {
  const original = AtomicJsonStore.prototype.write;
  let armed = true;
  return vi.spyOn(AtomicJsonStore.prototype, "write").mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
    if (armed && String((this as unknown as { file: string }).file).endsWith("plugin-schedules-state.json")) {
      armed = false;
      throw new Error("disk full");
    }
    return original.call(this, value);
  });
}

describe("PluginSchedulesService (v2)", () => {
  let workdir: string;
  let currentNow: Date;
  let idCounter: number;
  let engines: SchedulerEngine[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    currentNow = new Date(BASE_TIME);
    idCounter = 1;
    engines = [];
    workdir = mkdtempSync(join(tmpdir(), "ff-v2-schedules-"));
  });

  afterEach(() => {
    for (const engine of engines.splice(0)) {
      engine.stop();
    }
    vi.useRealTimers();
    rmSync(workdir, { recursive: true, force: true });
  });

  function setupHarness(options?: {
    runAgentTask?: (
      task: ScheduledTask,
      appointment: Date,
      requestedByUser: boolean,
    ) => Promise<ScheduledRunResult>;
    notifyApprovalRequired?: (notification: UnattendedApprovalNotification) => void;
    resolveTaskRisks?: (task: ScheduledTask) => ToolRisk[];
  }) {
    const store = createSchedulerStore({
      tasksFile: join(workdir, "scheduled-tasks.json"),
      historyFile: join(workdir, "scheduled-tasks-history.jsonl"),
      now: () => currentNow,
      id: () => `store-task-${idCounter++}`,
    });
    store.load();

    const notifications: UnattendedApprovalNotification[] = [];
    const runAgentMock = vi.fn(
      options?.runAgentTask
        ?? (async (): Promise<ScheduledRunResult> => ({
          ok: true,
          historyId: `agent-hist-${idCounter++}`,
          effectiveToolIds: [],
        })),
    );

    let engineRef: SchedulerEngine | undefined;
    const service = createPluginScheduleService({
      store,
      stateFile: join(workdir, "plugin-schedules-state.json"),
      now: () => currentNow,
      id: () => `id-${idCounter++}`,
      runAgentTask: runAgentMock,
      refreshEngine: () => engineRef?.refreshPluginTasks(),
      notifyApprovalRequired: (note) => {
        notifications.push(note);
        options?.notifyApprovalRequired?.(note);
      },
      resolveTaskRisks: options?.resolveTaskRisks,
    });

    const engine = new SchedulerEngine({
      store,
      runTask: service.runScheduledTask,
      now: () => currentNow,
      id: () => `eng-hist-${idCounter++}`,
    });
    engineRef = engine;
    engines.push(engine);
    engine.start();

    return { store, service, engine, runAgentMock, notifications };
  }

  function runSpec(overrides: Partial<ScheduleProposalSpec> = {}): ScheduleProposalSpec {
    return {
      title: "Morning digest",
      schedule: { kind: "interval", minutes: 30 },
      action: { type: "run", prompt: "Summarize unread updates", mode: "work" },
      ...overrides,
    };
  }

  async function expectErrorCode(promise: Promise<unknown>, expectedCode: string): Promise<void> {
    try {
      await promise;
      expect.unreachable(`Expected error ${expectedCode}, but resolved`);
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError);
      expect((error as PluginError).code).toBe(expectedCode);
    }
  }

  describe("proposal confirmation gate", () => {
    it("creates only a pending proposal on propose and never creates a scheduled task until confirmed", async () => {
      const { store, service, runAgentMock } = setupHarness();
      const pluginA = service.forPlugin("dev.firefly.alpha");

      const proposed = await pluginA.propose(runSpec());
      expect(proposed.status).toBe("pending_approval");
      expect(store.getTasks()).toHaveLength(0);
      expect(service.listPendingProposals("dev.firefly.alpha")).toHaveLength(1);

      const listedBefore = await pluginA.list();
      expect(listedBefore).toHaveLength(1);
      expect(listedBefore[0]).toMatchObject({
        taskId: proposed.taskId,
        pluginId: "dev.firefly.alpha",
        status: "pending_approval",
        nextFireAt: null,
      });

      // Advancing past the interval must not trigger unconfirmed proposals
      currentNow = new Date(BASE_TIME.getTime() + 60 * 60_000);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(runAgentMock).not.toHaveBeenCalled();
      expect(store.getTasks()).toHaveLength(0);
    });

    it("never creates a scheduled task when a proposal is rejected and blocks subsequent confirmation", async () => {
      const { store, service, runAgentMock } = setupHarness();
      const pluginA = service.forPlugin("dev.firefly.alpha");

      const proposed = await pluginA.propose(runSpec());
      const rejected = service.rejectProposal(proposed.taskId);
      expect(rejected.status).toBe("rejected");
      expect(store.getTasks()).toHaveLength(0);
      expect(service.listPendingProposals()).toHaveLength(0);

      expect(() => service.confirmProposal(proposed.taskId)).toThrowError(PluginError);
      try {
        service.confirmProposal(proposed.taskId);
      } catch (error) {
        expect((error as PluginError).code).toBe("ERR_REJECTED");
      }

      currentNow = new Date(BASE_TIME.getTime() + 60 * 60_000);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(runAgentMock).not.toHaveBeenCalled();
    });

    it("creates an enabled owned task on confirmation and fires it via SchedulerEngine", async () => {
      const { store, service, runAgentMock } = setupHarness();
      const pluginA = service.forPlugin("dev.firefly.alpha");

      const proposed = await pluginA.propose(runSpec());
      const confirmed = service.confirmProposal(proposed.taskId);

      expect(confirmed.status).toBe("active");
      expect(confirmed.pluginId).toBe("dev.firefly.alpha");
      expect(confirmed.nextFireAt).toBe("2032-03-10T10:30:00.000Z");

      const storedTasks = store.getTasks();
      expect(storedTasks).toHaveLength(1);
      expect(storedTasks[0]).toMatchObject({
        ownerPluginId: "dev.firefly.alpha",
        pluginUserEnabled: true,
        title: "Morning digest",
        mode: "work",
      });

      currentNow = new Date("2032-03-10T10:30:00.000Z");
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(runAgentMock).toHaveBeenCalledTimes(1);
      expect(runAgentMock.mock.calls[0][0].ownerPluginId).toBe("dev.firefly.alpha");
    });

    it("requires confirmation before a reschedule/update on a confirmed task takes effect", async () => {
      const { store, service, runAgentMock } = setupHarness();
      const pluginA = service.forPlugin("dev.firefly.alpha");

      const proposed = await pluginA.propose(runSpec({ schedule: { kind: "interval", minutes: 30 } }));
      service.confirmProposal(proposed.taskId);

      const updateRes = await pluginA.update(proposed.taskId, {
        title: "Afternoon digest",
        schedule: { kind: "interval", minutes: 60 },
      });
      expect(updateRes).toEqual({ status: "pending_approval" });

      // Live task in store still reflects the original confirmed spec before confirmation
      expect(store.getTasks()[0].title).toBe("Morning digest");
      expect(store.getTasks()[0].schedule).toEqual({ kind: "interval", every: 30, unit: "minutes" });

      // Rejecting the reschedule keeps the original schedule intact
      service.rejectProposal(proposed.taskId);
      expect(store.getTasks()[0].title).toBe("Morning digest");
      expect(store.getTasks()[0].schedule).toEqual({ kind: "interval", every: 30, unit: "minutes" });

      // Proposing a new update and confirming applies the new schedule to store and SchedulerEngine
      await pluginA.update(proposed.taskId, {
        title: "Hourly digest",
        schedule: { kind: "interval", minutes: 60 },
      });
      const updatedRecord = service.confirmProposal(proposed.taskId);
      expect(updatedRecord.status).toBe("active");
      expect(updatedRecord.title).toBe("Hourly digest");
      expect(store.getTasks()[0].schedule).toEqual({ kind: "interval", every: 60, unit: "minutes" });

      // 30 minutes is no longer due; 60 minutes triggers
      currentNow = new Date("2032-03-10T10:30:00.000Z");
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(runAgentMock).not.toHaveBeenCalled();

      currentNow = new Date("2032-03-10T11:00:00.000Z");
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(runAgentMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("plugin ownership isolation", () => {
    it("prevents Plugin A from updating or removing Plugin B's confirmed task or pending proposal", async () => {
      const { store, service } = setupHarness();
      const pluginA = service.forPlugin("dev.firefly.alpha");
      const pluginB = service.forPlugin("dev.firefly.beta");

      const pendingB = await pluginB.propose(runSpec({ title: "Beta pending" }));
      const confirmedBProp = await pluginB.propose(runSpec({ title: "Beta confirmed" }));
      service.confirmProposal(confirmedBProp.taskId);

      const snapshotBefore = JSON.stringify(store.getTasks());

      await expectErrorCode(
        pluginA.update(confirmedBProp.taskId, { title: "Hijacked" }),
        "ERR_PERMISSION",
      );
      await expectErrorCode(pluginA.remove(confirmedBProp.taskId), "ERR_PERMISSION");
      await expectErrorCode(
        pluginA.update(pendingB.taskId, { title: "Hijacked pending" }),
        "ERR_PERMISSION",
      );
      await expectErrorCode(pluginA.remove(pendingB.taskId), "ERR_PERMISSION");

      expect(JSON.stringify(store.getTasks())).toBe(snapshotBefore);
      expect(store.getTasks()[0].title).toBe("Beta confirmed");
      expect(service.listPendingProposals("dev.firefly.beta")).toHaveLength(1);
      expect(await pluginA.list()).toEqual([]);
    });

    it("prevents plugins from modifying or deleting user-created tasks", async () => {
      const { store, service } = setupHarness();
      const userTask = store.addTask({
        title: "User personal reminder",
        prompt: "Water the plants",
        schedule: { kind: "daily", timeOfDay: "08:00" },
        enabled: true,
        toolMode: "all-enabled",
        allowedToolIds: [],
      });

      const pluginA = service.forPlugin("dev.firefly.alpha");
      await expectErrorCode(pluginA.update(userTask.id, { title: "Stolen" }), "ERR_PERMISSION");
      await expectErrorCode(pluginA.remove(userTask.id), "ERR_PERMISSION");

      expect(store.getTasks()).toHaveLength(1);
      expect(store.getTasks()[0].title).toBe("User personal reminder");
    });

    it("allows a plugin to remove its own pending proposal or confirmed task", async () => {
      const { store, service } = setupHarness();
      const pluginA = service.forPlugin("dev.firefly.alpha");

      const p1 = await pluginA.propose(runSpec({ title: "Pending one" }));
      expect(await pluginA.remove(p1.taskId)).toBe(true);
      expect(service.listPendingProposals("dev.firefly.alpha")).toHaveLength(0);

      const p2 = await pluginA.propose(runSpec({ title: "Confirmed one" }));
      service.confirmProposal(p2.taskId);
      expect(store.getTasks()).toHaveLength(1);
      expect(await pluginA.remove(p2.taskId)).toBe(true);
      expect(store.getTasks()).toHaveLength(0);
      expect(await pluginA.remove(p2.taskId)).toBe(false);
    });
  });

  describe("plugin uninstall cleanup", () => {
    it("removes all tasks, proposals, and pending approvals of the uninstalled plugin while preserving other plugins and user tasks", async () => {
      const { store, service, runAgentMock } = setupHarness();
      const pluginA = service.forPlugin("dev.firefly.alpha");
      const pluginB = service.forPlugin("dev.firefly.beta");

      const userTask = store.addTask({
        title: "User task",
        prompt: "Keep running",
        schedule: { kind: "interval", every: 30, unit: "minutes" },
        enabled: true,
        toolMode: "all-enabled",
        allowedToolIds: [],
      });

      // Plugin A: 2 confirmed tasks (one with pending_approval run), 1 pending proposal
      const a1 = await pluginA.propose(runSpec({ title: "Alpha 1" }));
      service.confirmProposal(a1.taskId);
      const a2 = await pluginA.propose(
        runSpec({
          title: "Alpha privileged",
          schedule: { kind: "interval", minutes: 15 },
        }),
      );
      service.confirmProposal(a2.taskId);
      await pluginA.propose(runSpec({ title: "Alpha pending" }));

      // Alpha 2 has a run waiting for approval
      service.suspendUnattendedRun(a2.taskId, ["shell"]);
      expect(service.listPendingRunApprovals("dev.firefly.alpha")).toHaveLength(1);

      // Plugin B: 1 confirmed task, 1 pending proposal
      const b1 = await pluginB.propose(runSpec({ title: "Beta 1" }));
      service.confirmProposal(b1.taskId);
      await pluginB.propose(runSpec({ title: "Beta pending" }));

      const summary = service.uninstallPlugin("dev.firefly.alpha");
      expect(summary.removedTasks).toBe(2);
      expect(summary.removedProposals).toBe(3);
      expect(summary.cancelledApprovals).toBe(1);

      const remainingTasks = store.getTasks();
      expect(remainingTasks).toHaveLength(2);
      expect(remainingTasks.map((t) => t.title).sort()).toEqual(["Beta 1", "User task"]);
      expect(remainingTasks.find((t) => t.id === userTask.id)).toBeDefined();
      expect(service.listPendingProposals("dev.firefly.alpha")).toHaveLength(0);
      expect(service.listPendingProposals("dev.firefly.beta")).toHaveLength(1);
      expect(service.listPendingRunApprovals("dev.firefly.alpha")).toHaveLength(0);

      // Advancing time fires Plugin B and User task, never Plugin A
      runAgentMock.mockClear();
      currentNow = new Date("2032-03-10T10:45:00.000Z");
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      const executedTitles = runAgentMock.mock.calls.map((call) => call[0].title).sort();
      expect(executedTitles).toEqual(["Beta 1", "User task"]);
    });
  });

  describe("Firefly 1.2.0 refuses plugin tasks that would need unattended approval", () => {
    const PLUGIN = "dev.firefly.alpha";
    const STATE_FILE = () => join(workdir, "plugin-schedules-state.json");
    // Registry stand-in: tool ids map to the risks the real registry resolver would report.
    const REGISTRY_RISKS: Record<string, ToolRisk[]> = { "danger-shell": ["shell"], writer: ["fs-write"], mouse: ["input-control"], reader: ["fs-read"] };
    const resolveFromRegistry = (task: { allowedToolIds: readonly string[] }): ToolRisk[] => {
      const risks = new Set<ToolRisk>();
      for (const id of task.allowedToolIds) {
        const known = REGISTRY_RISKS[id];
        if (!known) risks.add("shell");
        else known.forEach((risk) => risks.add(risk));
      }
      return Array.from(risks);
    };

    const refusalCases: Array<{ name: string; spec: Partial<ScheduleProposalSpec>; resolver?: (task: ScheduledTask) => ToolRisk[] }> = [
      { name: "declared shell", spec: { requiredRisks: ["shell"] } },
      { name: "declared fs-write", spec: { requiredRisks: ["fs-write"] } },
      { name: "declared input-control", spec: { requiredRisks: ["input-control"] } },
      { name: "registry-derived fs-write", spec: { allowedToolIds: ["writer"] } },
      { name: "registry-derived input-control", spec: { allowedToolIds: ["reader", "mouse"] } },
      { name: "unregistered tool (unresolved)", spec: { allowedToolIds: ["not-installed"] } },
      { name: "resolver failure (unresolved)", spec: {}, resolver: () => { throw new Error("registry offline"); } },
    ];

    it.each(refusalCases)("refuses to confirm a create proposal with $name risk and writes nothing", async ({ spec, resolver }) => {
      const { store, service, runAgentMock, notifications } = setupHarness({ resolveTaskRisks: resolver ?? resolveFromRegistry });
      const client = service.forPlugin(PLUGIN);
      const proposed = await client.propose(runSpec({ schedule: { kind: "interval", minutes: 10 }, ...spec }));
      const stateBefore = readFileSync(STATE_FILE(), "utf8");

      let refusal: unknown;
      try { service.confirmProposal(proposed.taskId); } catch (error) { refusal = error; }

      expect(refusal).toBeInstanceOf(PluginError);
      expect(refusal).toMatchObject({ code: "ERR_PERMISSION", reason: "unattended_approval_unsupported" });
      expect(store.getTasks()).toEqual([]);
      expect(readFileSync(STATE_FILE(), "utf8")).toBe(stateBefore);
      expect(service.listPendingProposals(PLUGIN).map((p) => p.taskId)).toEqual([proposed.taskId]);

      currentNow = new Date("2032-03-10T10:30:00.000Z");
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(runAgentMock).not.toHaveBeenCalled();
      expect(notifications).toEqual([]);

      // The proposal is still pending, so the user can reject it.
      expect(service.rejectProposal(proposed.taskId).status).toBe("rejected");
    });

    it("refuses an update proposal that adds a risky tool and keeps the existing task unchanged", async () => {
      const { store, service } = setupHarness({ resolveTaskRisks: resolveFromRegistry });
      const client = service.forPlugin(PLUGIN);
      const created = await client.propose(runSpec({ schedule: { kind: "interval", minutes: 10 }, allowedToolIds: ["reader"] }));
      service.confirmProposal(created.taskId);
      const taskBefore = structuredClone(store.getTasks());
      await client.update(created.taskId, { allowedToolIds: ["reader", "danger-shell"] });
      const stateBefore = readFileSync(STATE_FILE(), "utf8");

      expect(() => service.confirmProposal(created.taskId)).toThrowError(
        expect.objectContaining({ code: "ERR_PERMISSION", reason: "unattended_approval_unsupported" }),
      );

      expect(store.getTasks()).toEqual(taskBefore);
      expect(readFileSync(STATE_FILE(), "utf8")).toBe(stateBefore);
      expect(service.listPendingProposals(PLUGIN)).toHaveLength(1);

      // Revising the proposal back to safe tools makes it confirmable.
      await client.update(created.taskId, { allowedToolIds: ["reader"], title: "Safe again" });
      expect(service.confirmProposal(created.taskId).title).toBe("Safe again");
    });

    it("refuses an update proposal that declares a risk", async () => {
      const { store, service } = setupHarness();
      const client = service.forPlugin(PLUGIN);
      const created = await client.propose(runSpec());
      service.confirmProposal(created.taskId);
      const taskBefore = structuredClone(store.getTasks());
      await client.update(created.taskId, { requiredRisks: ["fs-write"] });

      expect(() => service.confirmProposal(created.taskId)).toThrowError(
        expect.objectContaining({ code: "ERR_PERMISSION", reason: "unattended_approval_unsupported" }),
      );
      expect(store.getTasks()).toEqual(taskBefore);
    });

    it("still confirms and runs a safe one-shot task", async () => {
      const { store, service, runAgentMock } = setupHarness({ resolveTaskRisks: resolveFromRegistry });
      const client = service.forPlugin(PLUGIN);
      const proposed = await client.propose(runSpec({
        schedule: { kind: "once", at: BASE_TIME.getTime() + 10 * 60_000 },
        allowedToolIds: ["reader"],
        requiredRisks: ["fs-read", "network"],
      }));
      service.confirmProposal(proposed.taskId);
      expect(store.getTasks()).toHaveLength(1);

      currentNow = new Date("2032-03-10T10:10:00.000Z");
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(runAgentMock).toHaveBeenCalledTimes(1);
    });

    it("the IPC guard accepts a safe task, refuses it once its tools became risky, and ignores tasks the service does not manage", async () => {
      let risks: ToolRisk[] = [];
      const { store, service } = setupHarness({ resolveTaskRisks: () => risks });
      const proposed = await service.forPlugin(PLUGIN).propose(runSpec());
      service.confirmProposal(proposed.taskId);
      const [task] = store.getTasks();

      expect(() => service.assertTaskCanRunUnattended(task)).not.toThrow();
      risks = ["shell"];
      expect(() => service.assertTaskCanRunUnattended(task)).toThrowError(
        expect.objectContaining({ code: "ERR_PERMISSION", reason: "unattended_approval_unsupported" }),
      );
      expect(() => service.assertTaskCanRunUnattended({ ...task, id: "legacy-task" })).not.toThrow();
    });

    it.each<ToolRisk>(["fs-write", "shell", "input-control"])(
      "a recurring fire that needs %s approval executes nothing, records one skip, creates no pending record and pauses the task",
      async (risk) => {
        let risks: ToolRisk[] = [];
        const { store, service, runAgentMock, notifications } = setupHarness({ resolveTaskRisks: () => risks });
        const proposed = await service.forPlugin(PLUGIN).propose(runSpec({ schedule: { kind: "interval", minutes: 10 } }));
        service.confirmProposal(proposed.taskId);
        risks = [risk];

        currentNow = new Date("2032-03-10T10:10:00.000Z");
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        currentNow = new Date("2032-03-10T10:30:00.000Z");
        await vi.advanceTimersByTimeAsync(20 * 60_000);

        const [task] = store.getTasks();
        expect(runAgentMock).not.toHaveBeenCalled();
        expect(notifications).toEqual([]);
        expect(service.listPendingRunApprovals()).toEqual([]);
        expect(store.getHistory(task.id)).toEqual([
          expect.objectContaining({ status: "skipped", reason: "unattended run needs approval (not supported in 1.2.0)" }),
        ]);
        expect(task.pluginUserEnabled).toBe(false);
        expect((await service.forPlugin(PLUGIN).list())[0].status).toBe("paused");
      },
    );

    it("a one-shot fire that needs approval executes nothing and leaves no pending record", async () => {
      let risks: ToolRisk[] = [];
      const { store, service, runAgentMock } = setupHarness({ resolveTaskRisks: () => risks });
      const proposed = await service.forPlugin(PLUGIN).propose(runSpec({ schedule: { kind: "once", at: BASE_TIME.getTime() + 10 * 60_000 } }));
      service.confirmProposal(proposed.taskId);
      risks = ["shell"];

      currentNow = new Date("2032-03-10T10:10:00.000Z");
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      const [task] = store.getTasks();
      expect(runAgentMock).not.toHaveBeenCalled();
      expect(service.listPendingRunApprovals()).toEqual([]);
      expect(store.getHistory(task.id).map((entry) => entry.status)).toEqual(["skipped"]);
    });

    it("a blocked fire settles an approval that was already waiting as cancelled", async () => {
      let risks: ToolRisk[] = [];
      const { service, runAgentMock } = setupHarness({ resolveTaskRisks: () => risks });
      const proposed = await service.forPlugin(PLUGIN).propose(runSpec({ schedule: { kind: "interval", minutes: 10 } }));
      service.confirmProposal(proposed.taskId);
      const waiting = service.suspendUnattendedRun(proposed.taskId, ["shell"]);
      risks = ["shell"];

      currentNow = new Date("2032-03-10T10:10:00.000Z");
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(service.getRunApproval(waiting.runId)).toMatchObject({ status: "cancelled" });
      expect(service.listPendingRunApprovals()).toEqual([]);
      await expectErrorCode(service.approveRun(waiting.runId), "ERR_CANCELLED");
      expect(runAgentMock).not.toHaveBeenCalled();
    });
  });

  describe("unattended approval suspension (pending_approval)", () => {
    it("executes immediately without suspending for fs-read and network risks", async () => {
      const { service, runAgentMock, notifications } = setupHarness();
      const pluginA = service.forPlugin("dev.firefly.alpha");

      const proposed = await pluginA.propose(
        runSpec({
          schedule: { kind: "interval", minutes: 10 },
          requiredRisks: ["fs-read", "network"],
        }),
      );
      service.confirmProposal(proposed.taskId);

      currentNow = new Date("2032-03-10T10:10:00.000Z");
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(notifications).toHaveLength(0);
      expect(service.listPendingRunApprovals()).toHaveLength(0);
      expect(runAgentMock).toHaveBeenCalledTimes(1);
    });

    it("transitions pending_approval -> completed on approveRun and rejects duplicate settlement", async () => {
      const { service, runAgentMock } = setupHarness();
      const pluginA = service.forPlugin("dev.firefly.alpha");

      const proposed = await pluginA.propose(
        runSpec({
          schedule: { kind: "interval", minutes: 10 },
        }),
      );
      service.confirmProposal(proposed.taskId);
      const pending = service.suspendUnattendedRun(proposed.taskId, ["fs-write"]);
      expect(runAgentMock).not.toHaveBeenCalled();

      const settled = await service.approveRun(pending.runId);
      expect(settled.approval.status).toBe("completed");
      expect(settled.result.ok).toBe(true);
      expect(runAgentMock).toHaveBeenCalledTimes(1);
      expect(service.listPendingRunApprovals()).toHaveLength(0);

      await expectErrorCode(service.approveRun(pending.runId), "ERR_INVALID_ARGUMENT");
      expect(() => service.rejectRun(pending.runId)).toThrowError(PluginError);
      expect(runAgentMock).toHaveBeenCalledTimes(1);
    });

    it("transitions pending_approval -> rejected on rejectRun without executing and blocks later approval", async () => {
      const { store, service, runAgentMock } = setupHarness();
      const pluginA = service.forPlugin("dev.firefly.alpha");

      const proposed = await pluginA.propose(
        runSpec({
          schedule: { kind: "interval", minutes: 10 },
        }),
      );
      const confirmed = service.confirmProposal(proposed.taskId);
      const pending = service.suspendUnattendedRun(proposed.taskId, ["input-control"]);
      const rejected = service.rejectRun(pending.runId, "Not now");
      expect(rejected.status).toBe("rejected");
      expect(rejected.reason).toBe("Not now");
      expect(runAgentMock).not.toHaveBeenCalled();

      await expectErrorCode(service.approveRun(pending.runId), "ERR_REJECTED");
      expect(runAgentMock).not.toHaveBeenCalled();

      const storeTask = store.getTasks().find((t) => t.title === confirmed.title)!;
      const history = store.getHistory(storeTask.id);
      expect(history.some((entry) => entry.reason === "rejected: Not now")).toBe(true);
    });
  });

  describe("callbacks, cron re-arming, permissions, and persistence", () => {
    it("dispatches callback action triggers with exact taskId and payload and respects dispose()", async () => {
      const { service } = setupHarness();
      const pluginA = service.forPlugin("dev.firefly.reminder");
      const received: Array<{ taskId: string; payload: unknown; aborted: boolean }> = [];

      const sub = pluginA.onTrigger(async (event) => {
        received.push({
          taskId: event.taskId,
          payload: event.payload,
          aborted: event.signal.aborted,
        });
      });

      const proposed = await pluginA.propose({
        title: "Standup reminder",
        schedule: { kind: "interval", minutes: 5 },
        action: { type: "callback", payload: { channel: "desktop", text: "Stretch!" } },
      });
      service.confirmProposal(proposed.taskId);

      currentNow = new Date("2032-03-10T10:05:00.000Z");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(received).toEqual([
        {
          taskId: proposed.taskId,
          payload: { channel: "desktop", text: "Stretch!" },
          aborted: false,
        },
      ]);

      sub.dispose();
      currentNow = new Date("2032-03-10T10:10:00.000Z");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(received).toHaveLength(1);
    });

    describe.each([
      { listener: "never registered", dispose: false, register: false },
      { listener: "registered then disposed", dispose: true, register: true },
    ])("callback fire with listener $listener", ({ dispose, register }) => {
      const schedules = [
        { name: "recurring", schedule: { kind: "interval", minutes: 5 } as const },
        { name: "one-shot", schedule: { kind: "once", at: BASE_TIME.getTime() + 5 * 60_000 } as const },
      ];
      it.each(schedules)("$name task settles as skipped with ERR_UNAVAILABLE, never success", async ({ name, schedule }) => {
        const { store, service } = setupHarness();
        const client = service.forPlugin("dev.firefly.reminder");
        const seen: string[] = [];
        if (register) {
          const sub = client.onTrigger(async event => { seen.push(event.taskId); });
          if (dispose) sub.dispose();
        }
        const proposed = await client.propose({ title: "Stretch", schedule, action: { type: "callback" } });
        service.confirmProposal(proposed.taskId);

        currentNow = new Date("2032-03-10T10:05:00.000Z");
        await vi.advanceTimersByTimeAsync(5 * 60_000);

        const [task] = store.getTasks();
        const history = store.getHistory(task.id);
        expect(seen).toEqual([]);
        expect(history.map(entry => entry.status)).not.toContain("success");
        expect(history[0]).toMatchObject({ status: "skipped", reason: CALLBACK_LISTENER_UNAVAILABLE_REASON });
        if (name === "one-shot") {
          // Not marked completed: still enabled and re-armed for a retry.
          expect(task.pluginUserEnabled).toBe(true);
          expect(task.nextFireAt).toBe("2032-03-10T10:06:00.000Z");
        } else {
          expect(task.nextFireAt).toBe("2032-03-10T10:10:00.000Z");
        }
      });

      it("a direct run reports ok=false with the stable code and records no success", async () => {
        const { store, service } = setupHarness();
        const client = service.forPlugin("dev.firefly.reminder");
        if (register) client.onTrigger(async () => {}).dispose();
        const proposed = await client.propose({ title: "Stretch", schedule: { kind: "interval", minutes: 5 }, action: { type: "callback" } });
        service.confirmProposal(proposed.taskId);
        const [task] = store.getTasks();

        const result = await service.runScheduledTask(task, currentNow, true);

        expect(result).toMatchObject({ ok: false, error: CALLBACK_LISTENER_UNAVAILABLE_REASON });
        expect(store.getHistory(task.id)).toEqual([
          expect.objectContaining({ id: result.historyId, status: "skipped", reason: CALLBACK_LISTENER_UNAVAILABLE_REASON }),
        ]);
      });
    });

    it("a one-shot callback is retried and succeeds once the plugin registers its listener", async () => {
      const { store, service } = setupHarness();
      const client = service.forPlugin("dev.firefly.reminder");
      const proposed = await client.propose({
        title: "Once", schedule: { kind: "once", at: BASE_TIME.getTime() + 5 * 60_000 }, action: { type: "callback" },
      });
      service.confirmProposal(proposed.taskId);
      currentNow = new Date("2032-03-10T10:05:00.000Z");
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      const seen: string[] = [];
      client.onTrigger(async event => { seen.push(event.taskId); });
      currentNow = new Date("2032-03-10T10:06:00.000Z");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(seen).toEqual([proposed.taskId]);
      const [task] = store.getTasks();
      expect(store.getHistory(task.id).map(entry => entry.status)).toEqual(["success", "skipped"]);
      expect(task.nextFireAt).toBeNull();
    });

    it("a one-shot callback with no listener stops retrying once the window from its original time has passed", async () => {
      const { store, service } = setupHarness();
      const client = service.forPlugin("dev.firefly.reminder");
      const proposed = await client.propose({
        title: "Once", schedule: { kind: "once", at: BASE_TIME.getTime() + 5 * 60_000 }, action: { type: "callback" },
      });
      service.confirmProposal(proposed.taskId);

      currentNow = new Date("2032-03-10T10:05:00.000Z");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      // Keep stepping for 30 minutes past the original time (10:05); the window is 10 minutes.
      for (let minute = 6; minute <= 35; minute++) {
        currentNow = new Date(BASE_TIME.getTime() + minute * 60_000);
        await vi.advanceTimersByTimeAsync(60_000);
      }

      const [task] = store.getTasks();
      const history = store.getHistory(task.id);
      // Fires at 10:05 .. 10:14; the retry armed at 10:14 would land on the 10:15 deadline, so it is not armed.
      expect(history).toHaveLength(10);
      expect(history.map(entry => entry.status)).toEqual(Array(10).fill("skipped"));
      expect(history.every(entry => entry.reason === CALLBACK_LISTENER_UNAVAILABLE_REASON)).toBe(true);
      expect(task.nextFireAt).toBeNull();
    });

    it("re-arms general cron schedules after firing", async () => {
      const { store, service, runAgentMock } = setupHarness();
      const pluginA = service.forPlugin("dev.firefly.cron");

      const proposed = await pluginA.propose({
        title: "Quarter-hour check",
        schedule: { kind: "cron", expression: "*/15 * * * *", timezone: "UTC" },
        action: { type: "run", prompt: "Ping", mode: "work" },
      });
      const confirmed = service.confirmProposal(proposed.taskId);
      expect(confirmed.nextFireAt).toBe("2032-03-10T10:15:00.000Z");

      currentNow = new Date("2032-03-10T10:15:00.000Z");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(runAgentMock).toHaveBeenCalledTimes(1);
      expect(store.getTasks()[0].nextFireAt).toBe("2032-03-10T10:30:00.000Z");

      currentNow = new Date("2032-03-10T10:30:00.000Z");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(runAgentMock).toHaveBeenCalledTimes(2);
    });

    it("re-arms a cron task whose appointment passed while the app was closed instead of disabling it", async () => {
      const first = setupHarness();
      const proposed = await first.service.forPlugin("dev.firefly.cron").propose({
        title: "Quarter-hour check",
        schedule: { kind: "cron", expression: "*/15 * * * *", timezone: "UTC" },
        action: { type: "run", prompt: "Ping", mode: "work" },
      });
      expect(first.service.confirmProposal(proposed.taskId).nextFireAt).toBe("2032-03-10T10:15:00.000Z");
      first.engine.stop();

      currentNow = new Date("2032-03-10T10:20:00.000Z");
      vi.setSystemTime(currentNow);
      const store = createSchedulerStore({
        tasksFile: join(workdir, "scheduled-tasks.json"),
        historyFile: join(workdir, "scheduled-tasks-history.jsonl"),
        now: () => currentNow,
        id: () => `store-task-${idCounter++}`,
      });
      store.load();
      const runAgentTask = vi.fn(async (): Promise<ScheduledRunResult> => ({ ok: true, historyId: `h-${idCounter++}`, effectiveToolIds: [] }));
      const service = createPluginScheduleService({ store, stateFile: join(workdir, "plugin-schedules-state.json"), now: () => currentNow, id: () => `id-${idCounter++}`, runAgentTask });
      const engine = new SchedulerEngine({ store, runTask: service.runScheduledTask, now: () => currentNow, id: () => `eng-${idCounter++}` });
      engines.push(engine);
      engine.start();

      const [task] = store.getTasks();
      expect(task.pluginUserEnabled).not.toBe(false);
      expect(task.nextFireAt).toBe("2032-03-10T10:30:00.000Z");
      expect(task.schedule).toEqual({ kind: "cron", expression: "*/15 * * * *", timezone: "UTC" });
      currentNow = new Date("2032-03-10T10:30:00.000Z");
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(runAgentTask).toHaveBeenCalledTimes(1);
    });

    it("a stopped plugin instance's trigger callback is removed and its in-flight trigger is aborted", async () => {
      const { service } = setupHarness();
      const stopOld = new AbortController();
      const oldClient = service.forPlugin("dev.firefly.reminder", { signal: stopOld.signal });
      const seen: string[] = [];
      let inFlight: AbortSignal | undefined;
      let release!: () => void;
      oldClient.onTrigger(async (event) => {
        seen.push("old");
        inFlight = event.signal;
        await new Promise<void>(resolve => { release = resolve; });
      });
      const proposed = await oldClient.propose({
        title: "Stretch", schedule: { kind: "interval", minutes: 5 }, action: { type: "callback", payload: { n: 1 } },
      });
      service.confirmProposal(proposed.taskId);

      currentNow = new Date("2032-03-10T10:05:00.000Z");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(seen).toEqual(["old"]);
      stopOld.abort();
      expect(inFlight?.aborted).toBe(true);
      release();
      await vi.advanceTimersByTimeAsync(0);

      service.forPlugin("dev.firefly.reminder").onTrigger(async () => { seen.push("new"); });
      currentNow = new Date("2032-03-10T10:10:00.000Z");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(seen).toEqual(["old", "new"]);
    });

    it("keeps a callback run pending when its plugin stops and completes it after restart", async () => {
      const { service, store, runAgentMock } = setupHarness();
      const pluginId = "dev.firefly.reminder";
      const stopped = new AbortController();
      const client = service.forPlugin(pluginId, { signal: stopped.signal });
      const originalListener = vi.fn();
      client.onTrigger(originalListener);
      const payload = { text: "Stretch!" };
      const proposed = await client.propose({
        title: "Privileged reminder",
        schedule: { kind: "interval", minutes: 5 },
        action: { type: "callback", payload },
      });
      service.confirmProposal(proposed.taskId);
      const [task] = store.getTasks();
      const pending = service.suspendUnattendedRun(proposed.taskId, ["shell"]);
      const history = store.getHistory(task.id);
      stopped.abort();

      await expect(service.approveRun(pending.runId)).rejects.toMatchObject({
        code: "ERR_UNAVAILABLE",
        retryable: true,
      });
      expect(service.listPendingRunApprovals(pluginId)).toEqual([pending]);
      expect(store.getHistory(task.id)).toEqual(history);
      expect(originalListener).not.toHaveBeenCalled();

      const restartedListener = vi.fn();
      service.forPlugin(pluginId).onTrigger(restartedListener);
      const settled = await service.approveRun(pending.runId);

      expect(settled.approval.status).toBe("completed");
      expect(settled.result).toEqual({ ok: true, historyId: pending.runId, effectiveToolIds: [] });
      expect(restartedListener.mock.calls).toEqual([[{
        taskId: proposed.taskId,
        payload,
        signal: expect.objectContaining({ aborted: false }),
      }]]);
      expect(runAgentMock).not.toHaveBeenCalled();
      expect(store.getHistory(task.id)).toContainEqual(expect.objectContaining({
        id: pending.runId,
        status: "success",
      }));
    });

    it("a cron run that overlaps the next appointment does not end the schedule", async () => {
      let release!: () => void;
      const { store, service, runAgentMock } = setupHarness({
        runAgentTask: () => new Promise<ScheduledRunResult>(resolve => {
          release = () => resolve({ ok: true, historyId: `h-${idCounter++}`, effectiveToolIds: [] });
        }),
      });
      const proposed = await service.forPlugin("dev.firefly.cron").propose({
        title: "Slow check",
        schedule: { kind: "cron", expression: "*/15 * * * *", timezone: "UTC" },
        action: { type: "run", prompt: "Ping", mode: "work" },
      });
      service.confirmProposal(proposed.taskId);

      currentNow = new Date("2032-03-10T10:15:00.000Z");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(runAgentMock).toHaveBeenCalledTimes(1);
      currentNow = new Date("2032-03-10T10:31:00.000Z");
      await vi.advanceTimersByTimeAsync(16 * 60_000);
      expect(runAgentMock).toHaveBeenCalledTimes(1);

      release();
      await vi.advanceTimersByTimeAsync(0);
      const [task] = store.getTasks();
      expect(task.pluginUserEnabled).not.toBe(false);
      expect(task.nextFireAt).toBe("2032-03-10T10:45:00.000Z");
      expect(task.schedule).toEqual({ kind: "cron", expression: "*/15 * * * *", timezone: "UTC" });
    });

    it("confirming a task update cancels a run still waiting for approval of the old specification", async () => {
      const { service, runAgentMock } = setupHarness();
      const client = service.forPlugin("dev.firefly.alpha");
      const proposed = await client.propose(runSpec({ title: "old title", schedule: { kind: "interval", minutes: 15 } }));
      service.confirmProposal(proposed.taskId);
      const waiting = service.suspendUnattendedRun(proposed.taskId, ["shell"]);
      expect(waiting.title).toBe("old title");

      await client.update(proposed.taskId, { title: "NEW title", action: { type: "run", prompt: "NEW prompt", mode: "work" } });
      service.confirmProposal(proposed.taskId);

      expect(service.listPendingRunApprovals("dev.firefly.alpha")).toEqual([]);
      await expectErrorCode(service.approveRun(waiting.runId), "ERR_CANCELLED");
      expect(runAgentMock).not.toHaveBeenCalled();
    });

    it("a cron appointment skipped because the plugin is not running keeps the schedule going", async () => {
      const store = createSchedulerStore({
        tasksFile: join(workdir, "scheduled-tasks.json"),
        historyFile: join(workdir, "scheduled-tasks-history.jsonl"),
        now: () => currentNow,
        id: () => `store-task-${idCounter++}`,
      });
      store.load();
      const runAgentTask = vi.fn(async (): Promise<ScheduledRunResult> => ({ ok: true, historyId: `h-${idCounter++}`, effectiveToolIds: [] }));
      const service = createPluginScheduleService({ store, stateFile: join(workdir, "plugin-schedules-state.json"), now: () => currentNow, id: () => `id-${idCounter++}`, runAgentTask });
      let pluginRunning = false;
      const engine = new SchedulerEngine({ store, runTask: service.runScheduledTask, canRunTask: () => pluginRunning, now: () => currentNow, id: () => `eng-${idCounter++}` });
      engines.push(engine);
      engine.start();
      const proposed = await service.forPlugin("dev.firefly.cron").propose({
        title: "Quarter-hour check",
        schedule: { kind: "cron", expression: "*/15 * * * *", timezone: "UTC" },
        action: { type: "run", prompt: "Ping", mode: "work" },
      });
      service.confirmProposal(proposed.taskId);

      currentNow = new Date("2032-03-10T10:15:00.000Z");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(runAgentTask).not.toHaveBeenCalled();
      const [skipped] = store.getTasks();
      expect(skipped.pluginUserEnabled).not.toBe(false);
      expect(skipped.nextFireAt).toBe("2032-03-10T10:30:00.000Z");
      expect(skipped.schedule).toEqual({ kind: "cron", expression: "*/15 * * * *", timezone: "UTC" });

      pluginRunning = true;
      currentNow = new Date("2032-03-10T10:30:00.000Z");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(runAgentTask).toHaveBeenCalledTimes(1);
    });

    it("a payload that cannot be saved as JSON is refused without breaking later proposals", async () => {
      const { service } = setupHarness();
      const client = service.forPlugin("dev.firefly.alpha");
      const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
      for (const payload of [1n, cyclic]) {
        await expectErrorCode(client.propose({ title: "Bad", schedule: { kind: "interval", minutes: 5 }, action: { type: "callback", payload } }), "ERR_INVALID_ARGUMENT");
      }
      expect(service.listPendingProposals("dev.firefly.alpha")).toEqual([]);
      const ok = await client.propose(runSpec());
      expect(ok.status).toBe("pending_approval");
      expect(service.listPendingProposals("dev.firefly.alpha")).toHaveLength(1);
    });

    it("a confirmation whose plugin state cannot be saved leaves no task behind, and a retry creates exactly one", async () => {
      const { store, service } = setupHarness();
      const proposed = await service.forPlugin("dev.firefly.alpha").propose(runSpec());
      // Fail the next state save deterministically on every OS (a read-only file does not stop an atomic rename on POSIX).
      const failSave = failNextPluginStateSave();
      try {
        expect(() => service.confirmProposal(proposed.taskId)).toThrow(PluginError);
        expect(store.getTasks()).toEqual([]);
      } finally {
        failSave.mockRestore();
      }
      service.confirmProposal(proposed.taskId);
      expect(store.getTasks()).toHaveLength(1);
    });

    it("an approved run waits for the task's exclusive slot instead of running alongside another run", async () => {
      const { service } = setupHarness();
      const client = service.forPlugin("dev.firefly.alpha");
      let active = 0, peak = 0, release!: () => void;
      client.onTrigger(async () => {
        active += 1; peak = Math.max(peak, active);
        await new Promise<void>(resolve => { release = resolve; });
        active -= 1;
      });
      const proposed = await client.propose({ title: "Write", schedule: { kind: "interval", minutes: 15 }, action: { type: "callback" } });
      service.confirmProposal(proposed.taskId);
      const first = service.suspendUnattendedRun(proposed.taskId, ["shell"]);
      const second = service.suspendUnattendedRun(proposed.taskId, ["shell"]);

      const running = service.approveRun(first.runId);
      await vi.advanceTimersByTimeAsync(0);
      await expectErrorCode(service.approveRun(second.runId), "ERR_UNAVAILABLE");
      expect(service.getRunApproval(second.runId)?.status).toBe("pending_approval");
      release(); await running;

      const later = service.approveRun(second.runId);
      await vi.advanceTimersByTimeAsync(0);
      release(); await later;
      expect(peak).toBe(1);
      expect(service.getRunApproval(second.runId)?.status).toBe("completed");
    });

    it("a paused cron task stays paused while its time passes, and resuming it later schedules the next slot", async () => {
      const { store, service, runAgentMock } = setupHarness();
      const proposed = await service.forPlugin("dev.firefly.cron").propose({
        title: "Quarter-hour check",
        schedule: { kind: "cron", expression: "*/15 * * * *", timezone: "UTC" },
        action: { type: "run", prompt: "Ping", mode: "work" },
      });
      service.confirmProposal(proposed.taskId);
      const id = store.getTasks()[0].id;

      currentNow = new Date("2032-03-10T10:05:00.000Z");
      store.updateTask(id, { pluginUserEnabled: false });
      currentNow = new Date("2032-03-10T10:18:00.000Z");
      await vi.advanceTimersByTimeAsync(13 * 60_000);
      store.addTask({ title: "Unrelated", prompt: "x", enabled: false, schedule: { kind: "interval", every: 30, unit: "minutes" }, toolMode: "allow-list", allowedToolIds: [] });
      expect(store.getTasks().find(task => task.id === id)?.pluginUserEnabled).toBe(false);
      expect(runAgentMock).not.toHaveBeenCalled();

      currentNow = new Date("2032-03-10T10:20:00.000Z");
      store.updateTask(id, { pluginUserEnabled: true });
      const resumed = store.getTasks().find(task => task.id === id)!;
      expect(resumed.pluginUserEnabled).toBe(true);
      expect(resumed.nextFireAt).toBe("2032-03-10T10:30:00.000Z");
      expect(resumed.schedule).toEqual({ kind: "cron", expression: "*/15 * * * *", timezone: "UTC" });
    });

    it("an approved run still records its result after another operation's save failed meanwhile", async () => {
      const { service } = setupHarness();
      const client = service.forPlugin("dev.firefly.alpha");
      let release!: () => void;
      client.onTrigger(async () => { await new Promise<void>(resolve => { release = resolve; }); });
      const proposed = await client.propose({ title: "Write", schedule: { kind: "interval", minutes: 15 }, action: { type: "callback" } });
      service.confirmProposal(proposed.taskId);
      const waiting = service.suspendUnattendedRun(proposed.taskId, ["shell"]);

      const running = service.approveRun(waiting.runId);
      await vi.advanceTimersByTimeAsync(0);
      // Fail the next state save deterministically on every OS (a read-only file does not stop an atomic rename on POSIX).
      const failSave = failNextPluginStateSave();
      try {
        await expectErrorCode(client.propose(runSpec()), "ERR_INTERNAL");
      } finally {
        failSave.mockRestore();
      }
      release();
      const settled = await running;
      expect(settled.approval.status).toBe("completed");
      expect(service.getRunApproval(waiting.runId)?.status).toBe("completed");
    });

    it("does not restore an approval when a callback finishes after plugin uninstall", async () => {
      const { service } = setupHarness();
      const pluginId = "dev.firefly.reminder";
      const client = service.forPlugin(pluginId);
      let finish!: () => void;
      const callback = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
      client.onTrigger(callback);
      const proposed = await client.propose(runSpec({ action: { type: "callback" } }));
      service.confirmProposal(proposed.taskId);

      const pending = service.suspendUnattendedRun(proposed.taskId, ["shell"]);
      const running = service.approveRun(pending.runId);
      const outcome = running.catch((failure: unknown) => failure);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(service.getRunApproval(pending.runId)?.status).toBe("approved");

      service.uninstallPlugin(pluginId);
      expect(service.getRunApproval(pending.runId)).toBeUndefined();
      const stateFile = join(workdir, "plugin-schedules-state.json");
      const stateAfterUninstall = readFileSync(stateFile, "utf8");
      finish();
      const settled = await outcome;

      expect(service.getRunApproval(pending.runId)).toBeUndefined();
      expect(readFileSync(stateFile, "utf8")).toBe(stateAfterUninstall);
      expect(settled).toMatchObject({ code: "ERR_CANCELLED", retryable: false });
    });

    it("does not restore an approval when the approved action throws after task removal", async () => {
      let failAction!: (cause: Error) => void;
      const { service, runAgentMock } = setupHarness({
        runAgentTask: () => new Promise<ScheduledRunResult>((_resolve, reject) => { failAction = reject; }),
      });
      const client = service.forPlugin("dev.firefly.reminder");
      const proposed = await client.propose(runSpec());
      service.confirmProposal(proposed.taskId);

      const pending = service.suspendUnattendedRun(proposed.taskId, ["shell"]);
      const running = service.approveRun(pending.runId);
      const outcome = running.catch((failure: unknown) => failure);
      expect(runAgentMock).toHaveBeenCalledTimes(1);
      expect(service.getRunApproval(pending.runId)?.status).toBe("approved");

      expect(await client.remove(proposed.taskId)).toBe(true);
      expect(service.getRunApproval(pending.runId)).toBeUndefined();
      const stateFile = join(workdir, "plugin-schedules-state.json");
      const stateAfterRemoval = readFileSync(stateFile, "utf8");
      const actionFailure = new Error("Agent run failed");
      failAction(actionFailure);
      expect(await outcome).toBe(actionFailure);

      expect(service.getRunApproval(pending.runId)).toBeUndefined();
      expect(readFileSync(stateFile, "utf8")).toBe(stateAfterRemoval);
    });

    it("a cron task whose plan the user changed in the scheduler panel keeps the user's plan", async () => {
      const { store, service, runAgentMock } = setupHarness();
      const proposed = await service.forPlugin("dev.firefly.cron").propose({
        title: "Quarter-hour check",
        schedule: { kind: "cron", expression: "*/15 * * * *", timezone: "UTC" },
        action: { type: "run", prompt: "Ping", mode: "work" },
      });
      service.confirmProposal(proposed.taskId);
      const id = store.getTasks()[0].id;
      // What the panel's SCHEDULER_UPDATE saves: the new plan with a matching approval fingerprint.
      const edited = { kind: "interval" as const, every: 60, unit: "minutes" as const };
      const current = store.getTasks()[0];
      store.updateTask(id, { schedule: edited, nextFireAt: "2032-03-10T11:00:00.000Z",
        approvalFingerprint: computeExecutionSpecFingerprint({ schedule: edited, prompt: current.prompt, mode: current.mode ?? "work", allowedToolIds: current.allowedToolIds }) });

      currentNow = new Date("2032-03-10T11:00:00.000Z");
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(runAgentMock).toHaveBeenCalledTimes(1);
      expect(store.getTasks()[0].schedule).toEqual({ kind: "interval", every: 60, unit: "minutes" });
    });

    describe("the snapshot used to review an update", () => {
      async function confirmedTaskEditedByUser() {
        const harness = setupHarness();
        const client = harness.service.forPlugin("dev.firefly.digest");
        const proposed = await client.propose({
          title: "Digest",
          schedule: { kind: "interval", minutes: 30 },
          action: { type: "run", prompt: "Summarize", mode: "work" },
        });
        harness.service.confirmProposal(proposed.taskId);
        const stored = harness.store.getTasks()[0];
        harness.store.updateTask(stored.id, { schedule: { kind: "interval", every: 10, unit: "minutes" }, prompt: "Summarize loudly", mode: "chat" });
        return { ...harness, client, taskId: proposed.taskId };
      }

      it("shows the schedule, prompt and mode the user edited in the scheduler, not the plugin's original", async () => {
        const { service, client, taskId } = await confirmedTaskEditedByUser();
        await client.update(taskId, { title: "Digest v2" });

        expect(service.getTaskRecord(taskId)).toMatchObject({
          title: "Digest",
          schedule: { kind: "interval", minutes: 10 },
          action: { type: "run", prompt: "Summarize loudly", mode: "chat" },
        });
      });

      it("a title-only update proposal keeps the user's edited schedule and prompt instead of reverting them", async () => {
        const { service, store, client, taskId } = await confirmedTaskEditedByUser();
        await client.update(taskId, { title: "Digest v2" });

        expect(service.listPendingProposals()[0].spec).toMatchObject({
          title: "Digest v2",
          schedule: { kind: "interval", minutes: 10 },
          action: { type: "run", prompt: "Summarize loudly", mode: "chat" },
        });
        expect(store.getTasks()[0].schedule).toEqual({ kind: "interval", every: 10, unit: "minutes" });
      });

      it("keeps the plugin's own representation while the user has not edited the task", async () => {
        const { service, store } = setupHarness();
        const client = service.forPlugin("dev.firefly.cron");
        const proposed = await client.propose({
          title: "Check",
          schedule: { kind: "cron", expression: "*/15 * * * *", timezone: "UTC" },
          action: { type: "callback", payload: { n: 1 } },
        });
        service.confirmProposal(proposed.taskId);
        expect(store.getTasks()).toHaveLength(1);

        expect(service.getTaskRecord(proposed.taskId)).toMatchObject({
          schedule: { kind: "cron", expression: "*/15 * * * *", timezone: "UTC" },
          action: { type: "callback", payload: { n: 1 } },
        });
      });
    });

    it("a removal whose scheduled-task delete fails keeps the callback action intact", async () => {
      const { store, service, runAgentMock } = setupHarness();
      const client = service.forPlugin("dev.firefly.reminder");
      const fired: string[] = [];
      client.onTrigger(async event => { fired.push(event.taskId); });
      const proposed = await client.propose({ title: "Stretch", schedule: { kind: "interval", minutes: 5 }, action: { type: "callback" } });
      service.confirmProposal(proposed.taskId);

      const spy = vi.spyOn(store, "deleteTask").mockImplementationOnce(() => { throw new Error("disk full"); });
      await expectErrorCode(client.remove(proposed.taskId), "ERR_INTERNAL");
      spy.mockRestore();

      currentNow = new Date("2032-03-10T10:05:00.000Z");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(fired).toEqual([proposed.taskId]);
      expect(runAgentMock).not.toHaveBeenCalled();
    });

    it("an uninstall whose task delete fails keeps the plugin's schedule state and callbacks", async () => {
      const { store, service, runAgentMock } = setupHarness();
      const client = service.forPlugin("dev.firefly.reminder");
      const fired: string[] = [];
      client.onTrigger(async event => { fired.push(event.taskId); });
      const proposed = await client.propose({ title: "Stretch", schedule: { kind: "interval", minutes: 5 }, action: { type: "callback" } });
      service.confirmProposal(proposed.taskId);

      const spy = vi.spyOn(store, "deleteTasksByOwner").mockImplementationOnce(() => { throw new Error("disk full"); });
      expect(() => service.uninstallPlugin("dev.firefly.reminder")).toThrow(PluginError);
      spy.mockRestore();

      currentNow = new Date("2032-03-10T10:05:00.000Z");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(fired).toEqual([proposed.taskId]);
      expect(runAgentMock).not.toHaveBeenCalled();
    });

    it("rejects calls when plugin signal is aborted or schedules permission is revoked", async () => {
      const { service } = setupHarness();
      const ac = new AbortController();
      let permitted = true;
      const client = service.forPlugin("dev.firefly.alpha", {
        signal: ac.signal,
        hasPermission: () => permitted,
      });

      const created = await client.propose(runSpec());
      permitted = false;
      await expectErrorCode(client.propose(runSpec()), "ERR_PERMISSION");
      await expectErrorCode(client.list(), "ERR_PERMISSION");

      permitted = true;
      ac.abort();
      await expectErrorCode(client.update(created.taskId, { title: "x" }), "ERR_CANCELLED");
      await expectErrorCode(client.remove(created.taskId), "ERR_CANCELLED");
    });

    it("persists proposals, task metadata, and pending unattended approvals across service restart", async () => {
      const tasksFile = join(workdir, "scheduled-tasks.json");
      const historyFile = join(workdir, "scheduled-tasks-history.jsonl");
      const stateFile = join(workdir, "plugin-schedules-state.json");

      const store1 = createSchedulerStore({
        tasksFile,
        historyFile,
        now: () => currentNow,
        id: () => `store-task-${idCounter++}`,
      });
      store1.load();

      const service1 = createPluginScheduleService({
        store: store1,
        stateFile,
        now: () => currentNow,
        id: () => `id-${idCounter++}`,
      });

      const plugin1 = service1.forPlugin("dev.firefly.persist");
      const pendingProp = await plugin1.propose(runSpec({ title: "Pending across restart" }));
      const confirmedProp = await plugin1.propose({
        title: "Confirmed callback",
        schedule: { kind: "interval", minutes: 20 },
        action: { type: "callback", payload: { step: 42 } },
      });
      service1.confirmProposal(confirmedProp.taskId);

      // A run waiting for approval before restart
      service1.suspendUnattendedRun(confirmedProp.taskId, ["shell"]);
      expect(service1.listPendingRunApprovals("dev.firefly.persist")).toHaveLength(1);

      // Restart with new store and service instances reading the same files
      const store2 = createSchedulerStore({
        tasksFile,
        historyFile,
        now: () => currentNow,
        id: () => `store-task-${idCounter++}`,
      });
      store2.load();

      const service2 = createPluginScheduleService({
        store: store2,
        stateFile,
        now: () => currentNow,
        id: () => `id-${idCounter++}`,
      });

      expect(service2.listPendingProposals("dev.firefly.persist").map((p) => p.taskId)).toEqual([
        pendingProp.taskId,
      ]);

      const approvals2 = service2.listPendingRunApprovals("dev.firefly.persist");
      expect(approvals2).toHaveLength(1);

      const triggered: unknown[] = [];
      service2.forPlugin("dev.firefly.persist").onTrigger(async (e) => {
        triggered.push({ taskId: e.taskId, payload: e.payload });
      });

      const settled = await service2.approveRun(approvals2[0].runId);
      expect(settled.approval.status).toBe("completed");
      expect(triggered).toEqual([{ taskId: confirmedProp.taskId, payload: { step: 42 } }]);
    });

    it("settles an approval interrupted by host restart without replaying the callback", async () => {
      const { service, store, engine } = setupHarness();
      const pluginId = "dev.firefly.persist";
      const client = service.forPlugin(pluginId);
      // Leave the callback running so the last durable approval state is "approved".
      const interruptedListener = vi.fn(() => new Promise<void>(() => {}));
      client.onTrigger(interruptedListener);
      const proposed = await client.propose({
        title: "Privileged reminder",
        schedule: { kind: "interval", minutes: 15 },
        action: { type: "callback" },
      });
      service.confirmProposal(proposed.taskId);
      const [task] = store.getTasks();
      const interrupted = service.suspendUnattendedRun(proposed.taskId, ["shell"]);
      const pending = service.suspendUnattendedRun(proposed.taskId, ["shell"]);
      void service.approveRun(interrupted.runId);
      expect(interruptedListener).toHaveBeenCalledTimes(1);
      expect(service.getRunApproval(interrupted.runId)?.status).toBe("approved");
      const history = store.getHistory(task.id);
      engine.stop();

      const reopenService = () => {
        const reopenedStore = createSchedulerStore({
          tasksFile: join(workdir, "scheduled-tasks.json"),
          historyFile: join(workdir, "scheduled-tasks-history.jsonl"),
          now: () => currentNow,
        });
        reopenedStore.load();
        return {
          store: reopenedStore,
          service: createPluginScheduleService({
            store: reopenedStore,
            stateFile: join(workdir, "plugin-schedules-state.json"),
            now: () => currentNow,
          }),
        };
      };

      currentNow = new Date("2032-03-10T10:05:00.000Z");
      const restarted = reopenService();
      const recovered = {
        ...interrupted,
        status: "cancelled",
        reason: "host_interrupted",
        error: expect.stringContaining("Check run history and side effects"),
        settledAt: currentNow.toISOString(),
      };
      expect(restarted.service.getRunApproval(interrupted.runId)).toEqual(recovered);
      expect(restarted.service.listPendingRunApprovals(pluginId)).toEqual([pending]);
      const restartedListener = vi.fn();
      restarted.service.forPlugin(pluginId).onTrigger(restartedListener);
      await expect(restarted.service.approveRun(interrupted.runId)).rejects.toMatchObject({
        code: "ERR_CANCELLED",
        retryable: false,
        message: expect.stringContaining("Check run history and side effects"),
      });
      expect(() => restarted.service.rejectRun(interrupted.runId)).toThrowError(
        expect.objectContaining({ code: "ERR_CANCELLED" }),
      );
      expect(restartedListener).not.toHaveBeenCalled();
      expect(restarted.store.getHistory(task.id)).toEqual(history);

      currentNow = new Date("2032-03-10T10:10:00.000Z");
      expect(reopenService().service.getRunApproval(interrupted.runId)).toEqual(recovered);
    });

    it("rejects safe risk on plugin schedule proposals", async () => {
      const { service } = setupHarness();
      const client = service.forPlugin("dev.firefly.alpha");
      await expectErrorCode(
        client.propose(runSpec({ requiredRisks: ["safe" as never] })),
        "ERR_INVALID_ARGUMENT",
      );
    });

    it("updates a pending proposal in-place without creating a store task", async () => {
      const { store, service } = setupHarness();
      const client = service.forPlugin("dev.firefly.alpha");
      const proposed = await client.propose(runSpec({ title: "Draft 1" }));
      const updated = await client.update(proposed.taskId, { title: "Draft 2" });
      expect(updated).toEqual({ status: "pending_approval" });
      expect(store.getTasks()).toHaveLength(0);
      expect(service.listPendingProposals("dev.firefly.alpha")[0].spec.title).toBe("Draft 2");
    });

    it("supports runtime suspendUnattendedRun and handles callback failure transitions cleanly", async () => {
      const { service } = setupHarness();
      const client = service.forPlugin("dev.firefly.alpha");
      client.onTrigger(async () => {
        throw new Error("callback boom");
      });

      const proposed = await client.propose({
        title: "Runtime check",
        schedule: { kind: "interval", minutes: 15 },
        action: { type: "callback", payload: { n: 1 } },
      });
      service.confirmProposal(proposed.taskId);

      expect(() => service.suspendUnattendedRun(proposed.taskId, ["network"])).toThrowError(
        PluginError,
      );

      const suspended = service.suspendUnattendedRun(
        proposed.taskId,
        ["fs-write"],
        "write requested",
      );
      expect(suspended.status).toBe("pending_approval");

      const settled = await service.approveRun(suspended.runId);
      expect(settled.approval.status).toBe("failed");
      expect(settled.approval.error).toBe("callback boom");
      expect(settled.result.ok).toBe(false);
    });
  });
});
