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
  createPluginScheduleService,
  PluginScheduleError,
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
      expect(error).toBeInstanceOf(PluginScheduleError);
      expect((error as PluginScheduleError).code).toBe(expectedCode);
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

      expect(() => service.confirmProposal(proposed.taskId)).toThrowError(PluginScheduleError);
      try {
        service.confirmProposal(proposed.taskId);
      } catch (error) {
        expect((error as PluginScheduleError).code).toBe("ERR_REJECTED");
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
          requiredRisks: ["shell"],
        }),
      );
      service.confirmProposal(a2.taskId);
      await pluginA.propose(runSpec({ title: "Alpha pending" }));

      // Trigger Alpha 2 unattended so it enters pending_approval
      currentNow = new Date("2032-03-10T10:15:00.000Z");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
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

  describe("unattended approval suspension (pending_approval)", () => {
    it.each<ToolRisk>(["fs-write", "shell", "input-control"])(
      "suspends unattended execution requiring %s as pending_approval and notifies desktop",
      async (risk) => {
        const { service, runAgentMock, notifications } = setupHarness();
        const pluginA = service.forPlugin("dev.firefly.alpha");

        const proposed = await pluginA.propose(
          runSpec({
            title: `Privileged ${risk}`,
            schedule: { kind: "interval", minutes: 10 },
            requiredRisks: [risk],
          }),
        );
        service.confirmProposal(proposed.taskId);

        currentNow = new Date("2032-03-10T10:10:00.000Z");
        await vi.advanceTimersByTimeAsync(10 * 60_000);

        expect(runAgentMock).not.toHaveBeenCalled();
        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toMatchObject({
          taskId: proposed.taskId,
          pluginId: "dev.firefly.alpha",
          requiredRisks: [risk],
        });

        const approvals = service.listPendingRunApprovals("dev.firefly.alpha");
        expect(approvals).toHaveLength(1);
        expect(approvals[0].status).toBe("pending_approval");

        const [taskView] = await pluginA.list();
        expect(taskView.status).toBe("pending_approval");
        expect(taskView.pendingApprovalRunId).toBe(approvals[0].runId);
      },
    );

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
          requiredRisks: ["fs-write"],
        }),
      );
      service.confirmProposal(proposed.taskId);

      currentNow = new Date("2032-03-10T10:10:00.000Z");
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      const [pending] = service.listPendingRunApprovals();
      expect(runAgentMock).not.toHaveBeenCalled();

      const settled = await service.approveRun(pending.runId);
      expect(settled.approval.status).toBe("completed");
      expect(settled.result.ok).toBe(true);
      expect(runAgentMock).toHaveBeenCalledTimes(1);
      expect(service.listPendingRunApprovals()).toHaveLength(0);

      await expectErrorCode(service.approveRun(pending.runId), "ERR_INVALID_ARGUMENT");
      expect(() => service.rejectRun(pending.runId)).toThrowError(PluginScheduleError);
      expect(runAgentMock).toHaveBeenCalledTimes(1);
    });

    it("transitions pending_approval -> rejected on rejectRun without executing and blocks later approval", async () => {
      const { store, service, runAgentMock } = setupHarness();
      const pluginA = service.forPlugin("dev.firefly.alpha");

      const proposed = await pluginA.propose(
        runSpec({
          schedule: { kind: "interval", minutes: 10 },
          requiredRisks: ["input-control"],
        }),
      );
      const confirmed = service.confirmProposal(proposed.taskId);

      currentNow = new Date("2032-03-10T10:10:00.000Z");
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      const [pending] = service.listPendingRunApprovals();
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
        requiredRisks: ["shell"],
      });
      service.confirmProposal(proposed.taskId);
      const [task] = store.getTasks();

      currentNow = new Date("2032-03-10T10:05:00.000Z");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const [pending] = service.listPendingRunApprovals(pluginId);
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
    });

    it("confirming a task update cancels a run still waiting for approval of the old specification", async () => {
      const { service, runAgentMock } = setupHarness();
      const client = service.forPlugin("dev.firefly.alpha");
      const proposed = await client.propose(runSpec({ title: "old title", schedule: { kind: "interval", minutes: 15 }, requiredRisks: ["shell"] }));
      service.confirmProposal(proposed.taskId);
      currentNow = new Date("2032-03-10T10:15:00.000Z");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      const [waiting] = service.listPendingRunApprovals("dev.firefly.alpha");
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
        expect(() => service.confirmProposal(proposed.taskId)).toThrow(PluginScheduleError);
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
      const proposed = await client.propose({ title: "Write", schedule: { kind: "interval", minutes: 15 }, action: { type: "callback" }, requiredRisks: ["shell"] });
      service.confirmProposal(proposed.taskId);
      currentNow = new Date("2032-03-10T10:15:00.000Z");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      currentNow = new Date("2032-03-10T10:30:00.000Z");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      const [first, second] = service.listPendingRunApprovals("dev.firefly.alpha");

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
    });

    it("an approved run still records its result after another operation's save failed meanwhile", async () => {
      const { service } = setupHarness();
      const client = service.forPlugin("dev.firefly.alpha");
      let release!: () => void;
      client.onTrigger(async () => { await new Promise<void>(resolve => { release = resolve; }); });
      const proposed = await client.propose({ title: "Write", schedule: { kind: "interval", minutes: 15 }, action: { type: "callback" }, requiredRisks: ["shell"] });
      service.confirmProposal(proposed.taskId);
      currentNow = new Date("2032-03-10T10:15:00.000Z");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      const [waiting] = service.listPendingRunApprovals("dev.firefly.alpha");

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
      expect(() => service.uninstallPlugin("dev.firefly.reminder")).toThrow(PluginScheduleError);
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
        requiredRisks: ["shell"],
      });
      service1.confirmProposal(confirmedProp.taskId);

      // Simulate unattended run entering pending_approval before restart
      const taskRow = store1.getTasks()[0];
      await service1.runScheduledTask(taskRow, currentNow, false);
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
        PluginScheduleError,
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
