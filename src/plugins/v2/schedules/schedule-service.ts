import { randomUUID } from "node:crypto";
import { AtomicJsonStore } from "../../../main/base/storage/atomic-json-store";
import {
  computeExecutionSpecFingerprint,
  isPluginTaskEffectivelyEnabled,
} from "../../../main/features/scheduler/execution-spec";
import type {
  NewScheduledTaskInput,
  ScheduledRunResult,
  ScheduledTask,
  ScheduledTaskPatch,
} from "../../../main/platform/schedule/schedule-types";
import { computeNextCronFireAt, validateAndConvertSchedule } from "./cron";
import {
  PluginScheduleError,
  UNATTENDED_APPROVAL_RISKS,
  type Disposable,
  type Mode,
  type PluginClientOptions,
  type PluginScheduleServiceOptions,
  type PluginSchedulesClient,
  type Schedule,
  type ScheduleAction,
  type ScheduleProposal,
  type ScheduleProposalSpec,
  type TaskRecord,
  type ToolRisk,
  type TriggerEvent,
  type UnattendedApprovalRecord,
} from "./types";

const ALLOWED_MODES: ReadonlySet<Mode> = new Set<Mode>(["chat", "work", "code"]);
const ALLOWED_PLUGIN_RISKS: ReadonlySet<ToolRisk> = new Set<ToolRisk>([
  "fs-read",
  "fs-write",
  "shell",
  "network",
  "input-control",
]);

interface PluginTaskMetadata {
  taskId: string;
  storeTaskId: string;
  pluginId: string;
  schedule: Schedule;
  action: ScheduleAction;
  requiredRisks: ToolRisk[];
  requiresCronRearm: boolean;
  /** The one-shot appointment this service last set for a cron task; a different stored time means the user edited it. */
  armedRunAt?: string;
}

interface PersistedScheduleState {
  proposals: Record<string, ScheduleProposal>;
  metadata: Record<string, PluginTaskMetadata>;
  approvals: Record<string, UnattendedApprovalRecord>;
}

function emptyState(): PersistedScheduleState {
  return {
    proposals: {},
    metadata: {},
    approvals: {},
  };
}

function isPersistedState(value: unknown): value is PersistedScheduleState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedScheduleState>;
  return (
    candidate.proposals !== null
    && typeof candidate.proposals === "object"
    && candidate.metadata !== null
    && typeof candidate.metadata === "object"
    && candidate.approvals !== null
    && typeof candidate.approvals === "object"
  );
}

function cloneValue<T>(value: T): T {
  return value === undefined ? undefined as T : structuredClone(value);
}

function normalizeRisks(risks: unknown): ToolRisk[] {
  if (risks === undefined) return [];
  if (!Array.isArray(risks)) {
    throw new PluginScheduleError("ERR_INVALID_ARGUMENT", "requiredRisks must be an array");
  }
  const seen = new Set<ToolRisk>();
  for (const risk of risks) {
    if (typeof risk !== "string" || !ALLOWED_PLUGIN_RISKS.has(risk as ToolRisk)) {
      throw new PluginScheduleError(
        "ERR_INVALID_ARGUMENT",
        `Invalid plugin schedule tool risk: ${String(risk)}`,
      );
    }
    seen.add(risk as ToolRisk);
  }
  return Array.from(seen);
}

function normalizeToolIds(toolIds: unknown): string[] {
  if (toolIds === undefined) return [];
  if (!Array.isArray(toolIds) || toolIds.some((id) => typeof id !== "string")) {
    throw new PluginScheduleError("ERR_INVALID_ARGUMENT", "allowedToolIds must be an array of strings");
  }
  return Array.from(new Set(toolIds.map((id) => id.trim()).filter(Boolean)));
}

function normalizeAction(action: unknown): ScheduleAction {
  if (!action || typeof action !== "object") {
    throw new PluginScheduleError("ERR_INVALID_ARGUMENT", "Schedule action must be an object");
  }
  const candidate = action as Partial<ScheduleAction>;
  if (candidate.type === "run") {
    if (typeof candidate.prompt !== "string" || candidate.prompt.trim().length === 0) {
      throw new PluginScheduleError("ERR_INVALID_ARGUMENT", "Run action prompt must be non-empty");
    }
    if (typeof candidate.mode !== "string" || !ALLOWED_MODES.has(candidate.mode as Mode)) {
      throw new PluginScheduleError("ERR_INVALID_ARGUMENT", `Invalid run mode: ${String(candidate.mode)}`);
    }
    return {
      type: "run",
      prompt: candidate.prompt.trim(),
      mode: candidate.mode as Mode,
    };
  }
  if (candidate.type === "callback") {
    let payload: unknown = undefined;
    if ("payload" in candidate && candidate.payload !== undefined) {
      // The payload is persisted as JSON, so it must survive a JSON round trip (no BigInt, no cycles).
      try {
        payload = JSON.parse(JSON.stringify(candidate.payload));
      } catch (cause) {
        throw new PluginScheduleError("ERR_INVALID_ARGUMENT", "Callback payload must be JSON-serializable", { cause });
      }
    }
    return payload === undefined ? { type: "callback" } : { type: "callback", payload };
  }
  throw new PluginScheduleError(
    "ERR_INVALID_ARGUMENT",
    `Unsupported schedule action type: ${String((action as { type?: unknown }).type)}`,
  );
}

function normalizeProposalSpec(spec: ScheduleProposalSpec, now: Date): ScheduleProposalSpec {
  if (!spec || typeof spec !== "object") {
    throw new PluginScheduleError("ERR_INVALID_ARGUMENT", "Schedule proposal spec must be an object");
  }
  if (typeof spec.title !== "string" || spec.title.trim().length === 0) {
    throw new PluginScheduleError("ERR_INVALID_ARGUMENT", "Schedule title must be a non-empty string");
  }
  validateAndConvertSchedule(spec.schedule, now, { checkOnceInFuture: true });
  const action = normalizeAction(spec.action);
  const requiredRisks = normalizeRisks(spec.requiredRisks);
  const allowedToolIds = normalizeToolIds(spec.allowedToolIds);

  return {
    title: spec.title.trim(),
    schedule: cloneValue(spec.schedule),
    action,
    ...(requiredRisks.length > 0 ? { requiredRisks } : {}),
    ...(allowedToolIds.length > 0 ? { allowedToolIds } : {}),
  };
}

function ensureNonEmptyId(id: unknown, label: string): string {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new PluginScheduleError("ERR_INVALID_ARGUMENT", `${label} must be a non-empty string`);
  }
  return id;
}

function buildStorePromptAndMode(
  pluginId: string,
  title: string,
  action: ScheduleAction,
): { prompt: string; mode: Mode } {
  if (action.type === "run") {
    return { prompt: action.prompt.trim(), mode: action.mode };
  }
  return {
    prompt: `[plugin-callback:${pluginId}] ${title}`,
    mode: "work",
  };
}

export function createPluginScheduleService(options: PluginScheduleServiceOptions) {
  const { store } = options;
  const clock = options.now ?? (() => new Date());
  const nextId = options.id ?? (() => randomUUID());

  const backingFile = options.stateFile
    ? new AtomicJsonStore<PersistedScheduleState>(options.stateFile, isPersistedState)
    : undefined;

  let state: PersistedScheduleState = backingFile ? backingFile.read(emptyState()) : emptyState();

  const triggerListeners = new Map<string, Set<(event: TriggerEvent) => Promise<void> | void>>();
  const activeTriggerControllers = new Map<string, Set<AbortController>>();
  /** The stop signal of the plugin client that registered each listener. */
  const listenerSignals = new WeakMap<(event: TriggerEvent) => Promise<void> | void, AbortSignal>();

  function persistState(): void {
    if (!backingFile) return;
    try {
      backingFile.write(state);
    } catch (cause) {
      // Never keep an unsaved change in memory: go back to the last state on disk.
      state = backingFile.read(emptyState());
      throw new PluginScheduleError("ERR_INTERNAL", "Failed to persist plugin schedule state", { cause });
    }
  }

  function findMetadataByAnyId(id: string): PluginTaskMetadata | undefined {
    if (state.metadata[id]) return state.metadata[id];
    return Object.values(state.metadata).find((entry) => entry.storeTaskId === id);
  }

  function findStoreTaskByAnyId(id: string): ScheduledTask | undefined {
    const meta = findMetadataByAnyId(id);
    const targetStoreId = meta?.storeTaskId ?? id;
    return store.getTasks().find((task) => task.id === targetStoreId || task.id === id);
  }

  function findPendingProposalForTask(taskId: string): ScheduleProposal | undefined {
    const matches = Object.values(state.proposals).filter(
      (proposal) => proposal.taskId === taskId && proposal.status === "pending_approval",
    );
    return matches[matches.length - 1];
  }

  function findLatestProposalForTask(taskId: string): ScheduleProposal | undefined {
    const matches = Object.values(state.proposals).filter((proposal) => proposal.taskId === taskId);
    return matches[matches.length - 1];
  }

  function resolveOwnership(
    taskId: string,
  ): { ownerPluginId: string | undefined; hasStoreTask: boolean; hasProposal: boolean } {
    const storeTask = findStoreTaskByAnyId(taskId);
    const meta = findMetadataByAnyId(taskId);
    const proposal = findLatestProposalForTask(taskId);
    if (storeTask) {
      return { ownerPluginId: storeTask.ownerPluginId, hasStoreTask: true, hasProposal: Boolean(proposal) };
    }
    if (meta) {
      return { ownerPluginId: meta.pluginId, hasStoreTask: false, hasProposal: Boolean(proposal) };
    }
    if (proposal) {
      return { ownerPluginId: proposal.pluginId, hasStoreTask: false, hasProposal: true };
    }
    return { ownerPluginId: undefined, hasStoreTask: false, hasProposal: false };
  }

  function assertPluginOwnsTarget(pluginId: string, taskId: string, missingIsError: boolean): boolean {
    const { ownerPluginId, hasStoreTask, hasProposal } = resolveOwnership(taskId);
    if (!hasStoreTask && !hasProposal) {
      if (missingIsError) {
        throw new PluginScheduleError("ERR_INVALID_ARGUMENT", `Schedule task not found: ${taskId}`);
      }
      return false;
    }
    if (ownerPluginId !== pluginId) {
      throw new PluginScheduleError(
        "ERR_PERMISSION",
        `Plugin "${pluginId}" does not own schedule task "${taskId}"`,
      );
    }
    return true;
  }

  function toTaskRecordFromStore(task: ScheduledTask, meta?: PluginTaskMetadata): TaskRecord {
    const v2TaskId = meta?.taskId ?? task.id;
    const pendingProposal = findPendingProposalForTask(v2TaskId);
    const pendingApproval = Object.values(state.approvals).find(
      (record) => record.taskId === v2TaskId && record.status === "pending_approval",
    );
    const enabled = isPluginTaskEffectivelyEnabled(task);
    const fallbackSchedule: Schedule = task.schedule.kind === "once"
      ? { kind: "once", at: Date.parse(task.schedule.runAt) }
      : task.schedule.kind === "interval"
        ? {
            kind: "interval",
            minutes: task.schedule.unit === "hours" ? task.schedule.every * 60 : task.schedule.every,
          }
        : task.schedule.kind === "daily"
          ? { kind: "cron", expression: `${Number(task.schedule.timeOfDay.slice(3, 5))} ${Number(task.schedule.timeOfDay.slice(0, 2))} * * *` }
          : {
              kind: "cron",
              expression: `${Number(task.schedule.timeOfDay.slice(3, 5))} ${Number(task.schedule.timeOfDay.slice(0, 2))} * * ${task.schedule.dayOfWeek}`,
            };

    return {
      taskId: v2TaskId,
      pluginId: task.ownerPluginId ?? meta?.pluginId ?? "",
      title: task.title,
      schedule: cloneValue(meta?.schedule ?? fallbackSchedule),
      action: cloneValue(
        meta?.action ?? {
          type: "run",
          prompt: task.prompt,
          mode: task.mode ?? "work",
        },
      ),
      status: pendingProposal || pendingApproval ? "pending_approval" : enabled ? "active" : "paused",
      requiredRisks: [...(meta?.requiredRisks ?? [])],
      allowedToolIds: [...task.allowedToolIds],
      nextFireAt: task.nextFireAt,
      ...(task.lastFiredAt ? { lastFiredAt: task.lastFiredAt } : {}),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(pendingProposal ? { pendingProposalId: pendingProposal.proposalId } : {}),
      ...(pendingApproval ? { pendingApprovalRunId: pendingApproval.runId } : {}),
    };
  }

  function toTaskRecordFromProposal(proposal: ScheduleProposal): TaskRecord {
    return {
      taskId: proposal.taskId,
      pluginId: proposal.pluginId,
      title: proposal.spec.title,
      schedule: cloneValue(proposal.spec.schedule),
      action: cloneValue(proposal.spec.action),
      status: "pending_approval",
      requiredRisks: [...(proposal.spec.requiredRisks ?? [])],
      allowedToolIds: [...(proposal.spec.allowedToolIds ?? [])],
      nextFireAt: null,
      createdAt: proposal.createdAt,
      updatedAt: proposal.updatedAt,
      pendingProposalId: proposal.proposalId,
    };
  }

  function collectTaskRisks(task: ScheduledTask, meta?: PluginTaskMetadata): ToolRisk[] {
    const merged = new Set<ToolRisk>(meta?.requiredRisks ?? []);
    if (options.resolveTaskRisks) {
      for (const risk of options.resolveTaskRisks(task)) {
        merged.add(risk);
      }
    }
    return Array.from(merged);
  }

  async function executeConfirmedAction(
    v2TaskId: string,
    task: ScheduledTask,
    meta: PluginTaskMetadata | undefined,
    appointment: Date,
    requestedByUser: boolean,
    runId: string,
  ): Promise<ScheduledRunResult> {
    const action: ScheduleAction = meta?.action ?? {
      type: "run",
      prompt: task.prompt,
      mode: task.mode ?? "work",
    };

    if (action.type === "callback") {
      const listeners = Array.from(triggerListeners.get(task.ownerPluginId ?? "") ?? []);
      const controller = new AbortController();
      const pluginControllers = activeTriggerControllers.get(task.ownerPluginId ?? "") ?? new Set();
      pluginControllers.add(controller);
      activeTriggerControllers.set(task.ownerPluginId ?? "", pluginControllers);

      const startedAt = clock();
      try {
        for (const listener of listeners) {
          const stopped = listenerSignals.get(listener);
          // A stopped plugin instance never receives triggers, and stopping it aborts the one it is handling.
          if (stopped?.aborted) continue;
          await listener({
            taskId: v2TaskId,
            ...(action.payload !== undefined ? { payload: cloneValue(action.payload) } : {}),
            signal: stopped ? AbortSignal.any([controller.signal, stopped]) : controller.signal,
          });
        }
        const finishedAt = clock();
        store.recordHistory({
          id: runId,
          taskId: task.id,
          taskTitle: task.title,
          firedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          status: "success",
          effectiveToolIds: [...task.allowedToolIds],
        });
        return {
          ok: true,
          historyId: runId,
          effectiveToolIds: [...task.allowedToolIds],
        };
      } catch (failure) {
        const finishedAt = clock();
        const message = failure instanceof Error ? failure.message : String(failure);
        store.recordHistory({
          id: runId,
          taskId: task.id,
          taskTitle: task.title,
          firedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          status: "failed",
          errorMessage: message,
          effectiveToolIds: [...task.allowedToolIds],
        });
        return {
          ok: false,
          error: message,
          historyId: runId,
          effectiveToolIds: [...task.allowedToolIds],
        };
      } finally {
        pluginControllers.delete(controller);
        if (pluginControllers.size === 0 && task.ownerPluginId) {
          activeTriggerControllers.delete(task.ownerPluginId);
        }
      }
    }

    if (!options.runAgentTask) {
      throw new PluginScheduleError("ERR_UNAVAILABLE", "No agent run delegate configured for schedule execution");
    }
    return options.runAgentTask(task, appointment, requestedByUser);
  }

  function rearmCronTaskIfNeeded(
    task: ScheduledTask,
    meta: PluginTaskMetadata | undefined,
    appointment: Date,
  ): void {
    if (!meta || !meta.requiresCronRearm || meta.schedule.kind !== "cron") return;
    // Callers may hold a snapshot taken before an earlier re-arm in the same run; decide on the stored task.
    task = store.getTasks().find(candidate => candidate.id === task.id) ?? task;
    // The user may have changed the plan in the scheduler panel. Only a one-shot appointment that this service
    // set is still the cron's; anything else means the user took over, so stop re-arming.
    if (task.schedule.kind !== "once" || (meta.armedRunAt !== undefined && task.schedule.runAt !== meta.armedRunAt)) {
      meta.requiresCronRearm = false;
      try { persistState(); } catch { /* The flag is re-derived as false on the next check anyway. */ }
      return;
    }
    const anchor = new Date(Math.max(appointment.getTime(), clock().getTime()));
    const nextFire = computeNextCronFireAt(meta.schedule.expression, anchor, meta.schedule.timezone);
    const nextSchedule = { kind: "once" as const, runAt: nextFire.toISOString() };
    const nextFingerprint = computeExecutionSpecFingerprint({
      schedule: nextSchedule,
      prompt: task.prompt,
      mode: task.mode ?? "work",
      allowedToolIds: task.allowedToolIds,
    });
    store.updateTask(task.id, {
      schedule: nextSchedule,
      nextFireAt: nextFire.toISOString(),
      pluginUserEnabled: true,
      approvalFingerprint: nextFingerprint,
    });
    meta.armedRunAt = nextSchedule.runAt;
    try { persistState(); } catch { /* A stale armedRunAt only stops re-arming; the task itself is saved. */ }
  }

  /**
   * Re-arm cron tasks whose stored one-shot appointment passed while the app was closed. Must run before the
   * engine's overdue handling (start and refresh), which would otherwise disable them as expired one-shots.
   * Paused tasks stay paused.
   */
  function reconcileCronTasks(): number {
    const now = clock();
    let rearmed = 0;
    for (const meta of Object.values(state.metadata)) {
      if (!meta.requiresCronRearm || meta.schedule.kind !== "cron") continue;
      const task = store.getTasks().find(candidate => candidate.id === meta.storeTaskId);
      if (!task || task.pluginUserEnabled === false || task.schedule.kind !== "once") continue;
      if (new Date(task.schedule.runAt).getTime() > now.getTime()) continue;
      rearmCronTaskIfNeeded(task, meta, now);
      rearmed += 1;
    }
    return rearmed;
  }

  function refreshEngine(): void {
    reconcileCronTasks();
    options.refreshEngine?.();
  }

  function createApprovalSuspension(
    task: ScheduledTask,
    v2TaskId: string,
    appointment: Date,
    blockingRisks: ToolRisk[],
    reason?: string,
  ): UnattendedApprovalRecord {
    const runId = `run-approval-${nextId()}`;
    const record: UnattendedApprovalRecord = {
      runId,
      taskId: v2TaskId,
      pluginId: task.ownerPluginId ?? "",
      title: task.title,
      appointmentAt: appointment.toISOString(),
      status: "pending_approval",
      requiredRisks: [...blockingRisks],
      ...(reason ? { reason } : {}),
      createdAt: clock().toISOString(),
    };
    state.approvals[runId] = record;
    persistState();

    store.recordHistory({
      id: runId,
      taskId: task.id,
      taskTitle: task.title,
      firedAt: appointment.toISOString(),
      status: "skipped",
      reason: "pending_approval",
      effectiveToolIds: [...task.allowedToolIds],
    });

    options.notifyApprovalRequired?.({
      runId,
      taskId: v2TaskId,
      pluginId: record.pluginId,
      title: record.title,
      requiredRisks: [...blockingRisks],
      ...(reason ? { reason } : {}),
    });

    return cloneValue(record);
  }

  function forPlugin(pluginId: string, clientOptions?: PluginClientOptions): PluginSchedulesClient {
    const ownerPluginId = ensureNonEmptyId(pluginId, "pluginId");

    function assertActiveAndPermitted(): void {
      if (clientOptions?.signal?.aborted) {
        throw new PluginScheduleError("ERR_CANCELLED", `Plugin "${ownerPluginId}" is stopped`);
      }
      if (clientOptions?.hasPermission && !clientOptions.hasPermission()) {
        throw new PluginScheduleError(
          "ERR_PERMISSION",
          `Plugin "${ownerPluginId}" does not hold "schedules" permission`,
        );
      }
    }

    return {
      async propose(spec) {
        assertActiveAndPermitted();
        const now = clock();
        const normalizedSpec = normalizeProposalSpec(spec, now);

        let taskId = `psched-${nextId()}`;
        while (state.metadata[taskId] || findLatestProposalForTask(taskId)) {
          taskId = `psched-${nextId()}`;
        }
        const proposalId = `prop-${nextId()}`;
        const timestamp = now.toISOString();

        // Proposals never write to SchedulerStore until explicit user confirmation.
        state.proposals[proposalId] = {
          proposalId,
          taskId,
          pluginId: ownerPluginId,
          kind: "create",
          status: "pending_approval",
          spec: normalizedSpec,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        persistState();

        return { taskId, status: "pending_approval" };
      },

      async update(taskId, patch) {
        assertActiveAndPermitted();
        ensureNonEmptyId(taskId, "taskId");
        if (!patch || typeof patch !== "object") {
          throw new PluginScheduleError("ERR_INVALID_ARGUMENT", "Update patch must be an object");
        }
        assertPluginOwnsTarget(ownerPluginId, taskId, true);

        const now = clock();
        const pending = findPendingProposalForTask(taskId);
        const liveTask = findStoreTaskByAnyId(taskId);
        const meta = findMetadataByAnyId(taskId);

        const baseSpec: ScheduleProposalSpec = pending
          ? pending.spec
          : meta
            ? {
                title: liveTask?.title ?? "",
                schedule: meta.schedule,
                action: meta.action,
                requiredRisks: meta.requiredRisks,
                allowedToolIds: liveTask?.allowedToolIds ?? [],
              }
            : {
                title: liveTask!.title,
                schedule: toTaskRecordFromStore(liveTask!).schedule,
                action: {
                  type: "run",
                  prompt: liveTask!.prompt,
                  mode: liveTask!.mode ?? "work",
                },
                allowedToolIds: liveTask!.allowedToolIds,
              };

        const mergedRaw: ScheduleProposalSpec = {
          title: patch.title !== undefined ? patch.title : baseSpec.title,
          schedule: patch.schedule !== undefined ? patch.schedule : baseSpec.schedule,
          action: patch.action !== undefined ? patch.action : baseSpec.action,
          requiredRisks: patch.requiredRisks !== undefined ? patch.requiredRisks : baseSpec.requiredRisks,
          allowedToolIds: patch.allowedToolIds !== undefined ? patch.allowedToolIds : baseSpec.allowedToolIds,
        };
        const normalizedSpec = normalizeProposalSpec(mergedRaw, now);
        const timestamp = now.toISOString();

        if (pending) {
          state.proposals[pending.proposalId] = {
            ...pending,
            spec: normalizedSpec,
            updatedAt: timestamp,
          };
          persistState();
          return { status: "pending_approval" };
        }

        const proposalId = `prop-${nextId()}`;
        state.proposals[proposalId] = {
          proposalId,
          taskId,
          pluginId: ownerPluginId,
          kind: "update",
          status: "pending_approval",
          spec: normalizedSpec,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        persistState();

        return { status: "pending_approval" };
      },

      async remove(taskId) {
        assertActiveAndPermitted();
        ensureNonEmptyId(taskId, "taskId");

        const owned = assertPluginOwnsTarget(ownerPluginId, taskId, false);
        if (!owned) return false;

        let removed = false;
        const meta = state.metadata[taskId];
        const storeTaskId = meta?.storeTaskId ?? taskId;
        // Delete the scheduled task first: if that fails, the plugin state (action metadata, approvals) must stay,
        // or a surviving callback task would later run as a plain agent prompt.
        try {
          if (store.deleteTask(storeTaskId)) {
            removed = true;
          }
        } catch (cause) {
          throw new PluginScheduleError("ERR_INTERNAL", "Failed to delete scheduled task", { cause });
        }
        for (const [proposalId, proposal] of Object.entries(state.proposals)) {
          if (proposal.taskId === taskId && proposal.pluginId === ownerPluginId) {
            delete state.proposals[proposalId];
            removed = true;
          }
        }
        if (meta) {
          delete state.metadata[taskId];
          removed = true;
        }
        for (const [runId, approval] of Object.entries(state.approvals)) {
          if (approval.taskId === taskId && approval.pluginId === ownerPluginId) {
            delete state.approvals[runId];
          }
        }
        persistState();
        return removed;
      },

      async list() {
        assertActiveAndPermitted();
        const records: TaskRecord[] = [];
        const seenTaskIds = new Set<string>();

        for (const task of store.getTasks()) {
          if (task.ownerPluginId !== ownerPluginId) continue;
          const meta = findMetadataByAnyId(task.id);
          const record = toTaskRecordFromStore(task, meta);
          seenTaskIds.add(record.taskId);
          records.push(record);
        }

        for (const proposal of Object.values(state.proposals)) {
          if (
            proposal.pluginId === ownerPluginId
            && proposal.kind === "create"
            && proposal.status === "pending_approval"
            && !seenTaskIds.has(proposal.taskId)
          ) {
            records.push(toTaskRecordFromProposal(proposal));
          }
        }

        return records;
      },

      onTrigger(fn) {
        assertActiveAndPermitted();
        if (typeof fn !== "function") {
          throw new PluginScheduleError("ERR_INVALID_ARGUMENT", "onTrigger listener must be a function");
        }
        let listeners = triggerListeners.get(ownerPluginId);
        if (!listeners) {
          listeners = new Set();
          triggerListeners.set(ownerPluginId, listeners);
        }
        listeners.add(fn);
        const dispose = (): void => {
          listeners?.delete(fn);
          if (listeners && listeners.size === 0 && triggerListeners.get(ownerPluginId) === listeners) {
            triggerListeners.delete(ownerPluginId);
          }
        };
        const stop = clientOptions?.signal;
        if (stop) {
          listenerSignals.set(fn, stop);
          stop.addEventListener("abort", dispose, { once: true });
        }

        return { dispose };
      },
    };
  }

  function listPendingProposals(pluginId?: string): ScheduleProposal[] {
    return Object.values(state.proposals)
      .filter(
        (proposal) =>
          proposal.status === "pending_approval"
          && (pluginId === undefined || proposal.pluginId === pluginId),
      )
      .map((proposal) => cloneValue(proposal));
  }

  function confirmProposal(taskId: string): TaskRecord {
    ensureNonEmptyId(taskId, "taskId");
    const proposal = findPendingProposalForTask(taskId);
    if (!proposal) {
      const latest = findLatestProposalForTask(taskId);
      if (latest?.status === "rejected") {
        throw new PluginScheduleError("ERR_REJECTED", `Proposal for task "${taskId}" was already rejected`);
      }
      throw new PluginScheduleError("ERR_INVALID_ARGUMENT", `No pending proposal found for task "${taskId}"`);
    }

    const now = clock();
    const { storeSchedule, requiresCronRearm } = validateAndConvertSchedule(
      proposal.spec.schedule,
      now,
      { checkOnceInFuture: true },
    );
    const { prompt, mode } = buildStorePromptAndMode(
      proposal.pluginId,
      proposal.spec.title,
      proposal.spec.action,
    );
    const allowedToolIds = normalizeToolIds(proposal.spec.allowedToolIds);
    const requiredRisks = normalizeRisks(proposal.spec.requiredRisks);
    const fingerprint = computeExecutionSpecFingerprint({
      schedule: storeSchedule,
      prompt,
      mode,
      allowedToolIds,
    });

    if (proposal.kind === "create") {
      const input: NewScheduledTaskInput = {
        title: proposal.spec.title,
        prompt,
        enabled: false,
        schedule: storeSchedule,
        toolMode: "allow-list",
        allowedToolIds,
        ownerPluginId: proposal.pluginId,
        pluginUserEnabled: true,
        approvalFingerprint: fingerprint,
        mode,
      };
      const created = store.addTask(input);
      // The task store and the plugin state are two files: if the second write fails, remove the task again so a
      // retry cannot create a duplicate and no task without its action metadata is left to run.
      const undoCreate = () => { try { store.deleteTask(created.id); } catch { /* Best effort; surfaced below. */ } };
      const meta: PluginTaskMetadata = {
        taskId: proposal.taskId,
        storeTaskId: created.id,
        pluginId: proposal.pluginId,
        schedule: cloneValue(proposal.spec.schedule),
        action: cloneValue(proposal.spec.action),
        requiredRisks,
        requiresCronRearm,
        ...(requiresCronRearm && storeSchedule.kind === "once" ? { armedRunAt: storeSchedule.runAt } : {}),
      };
      state.metadata[proposal.taskId] = meta;
      state.proposals[proposal.proposalId] = {
        ...proposal,
        status: "confirmed",
        updatedAt: now.toISOString(),
      };
      try {
        persistState();
      } catch (failure) {
        undoCreate();
        throw failure;
      }
      return toTaskRecordFromStore(created, meta);
    }

    const existingTask = findStoreTaskByAnyId(proposal.taskId);
    if (!existingTask || existingTask.ownerPluginId !== proposal.pluginId) {
      throw new PluginScheduleError(
        "ERR_INVALID_ARGUMENT",
        `Target task "${proposal.taskId}" no longer exists for update confirmation`,
      );
    }

    const patch: ScheduledTaskPatch = {
      title: proposal.spec.title,
      schedule: storeSchedule,
      prompt,
      mode,
      allowedToolIds,
      pluginUserEnabled: true,
      approvalFingerprint: fingerprint,
    };
    const previous: ScheduledTaskPatch = {
      title: existingTask.title,
      schedule: existingTask.schedule,
      prompt: existingTask.prompt,
      mode: existingTask.mode,
      allowedToolIds: existingTask.allowedToolIds,
      pluginUserEnabled: existingTask.pluginUserEnabled,
      approvalFingerprint: existingTask.approvalFingerprint,
      nextFireAt: existingTask.nextFireAt,
    };
    const updated = store.updateTask(existingTask.id, patch);
    // A run waiting for approval was requested for the old specification; it must not run the new one.
    for (const approval of Object.values(state.approvals)) {
      if (approval.taskId === proposal.taskId && approval.status === "pending_approval") {
        approval.status = "cancelled";
        approval.reason = "task updated";
        approval.settledAt = now.toISOString();
      }
    }
    const meta: PluginTaskMetadata = {
      taskId: proposal.taskId,
      storeTaskId: updated.id,
      pluginId: proposal.pluginId,
      schedule: cloneValue(proposal.spec.schedule),
      action: cloneValue(proposal.spec.action),
      requiredRisks,
      requiresCronRearm,
      ...(requiresCronRearm && storeSchedule.kind === "once" ? { armedRunAt: storeSchedule.runAt } : {}),
    };
    state.metadata[proposal.taskId] = meta;
    state.proposals[proposal.proposalId] = {
      ...proposal,
      status: "confirmed",
      updatedAt: now.toISOString(),
    };
    try {
      persistState();
    } catch (failure) {
      try { store.updateTask(existingTask.id, previous); } catch { /* Best effort; surfaced below. */ }
      throw failure;
    }
    return toTaskRecordFromStore(updated, meta);
  }

  function rejectProposal(taskId: string): ScheduleProposal {
    ensureNonEmptyId(taskId, "taskId");
    const proposal = findPendingProposalForTask(taskId);
    if (!proposal) {
      const latest = findLatestProposalForTask(taskId);
      if (latest?.status === "rejected") {
        throw new PluginScheduleError("ERR_REJECTED", `Proposal for task "${taskId}" was already rejected`);
      }
      throw new PluginScheduleError("ERR_INVALID_ARGUMENT", `No pending proposal found for task "${taskId}"`);
    }

    const updated: ScheduleProposal = {
      ...proposal,
      status: "rejected",
      updatedAt: clock().toISOString(),
    };
    state.proposals[proposal.proposalId] = updated;
    persistState();
    return cloneValue(updated);
  }

  /** Store task ids with an action in progress, from the engine or from an approved run. */
  const runningTasks = new Set<string>();

  async function runScheduledTask(
    task: ScheduledTask,
    appointment: Date,
    requestedByUser: boolean,
  ): Promise<ScheduledRunResult> {
    if (runningTasks.has(task.id)) {
      const historyId = `skip-${nextId()}`;
      store.recordHistory({ id: historyId, taskId: task.id, taskTitle: task.title, firedAt: appointment.toISOString(), status: "skipped", reason: "task already running", effectiveToolIds: [] });
      return { ok: false, error: "task already running", historyId, effectiveToolIds: [] };
    }
    runningTasks.add(task.id);
    try {
      return await runScheduledTaskOnce(task, appointment, requestedByUser);
    } finally {
      runningTasks.delete(task.id);
      rearmCronStoppedDuringRun(task.id);
    }
  }

  /**
   * A cron appointment that comes due while the previous run is still going is skipped by the engine, which
   * first disables the stored one-shot. Once the run ends, re-arm such a task from now. A task the user paused
   * keeps a future appointment, so it is left alone.
   */
  function rearmCronStoppedDuringRun(storeTaskId: string): void {
    const meta = findMetadataByAnyId(storeTaskId);
    if (!meta?.requiresCronRearm || meta.schedule.kind !== "cron") return;
    const current = store.getTasks().find(candidate => candidate.id === meta.storeTaskId);
    // Two ways to end up with no appointment: the engine stopped the one-shot (disabled), or the user resumed a
    // paused task after its stored time passed and the store cleared the expired appointment (enabled).
    if (!current || current.nextFireAt !== null || current.schedule.kind !== "once") return;
    const now = clock();
    if (new Date(current.schedule.runAt).getTime() > now.getTime()) return;
    rearmCronTaskIfNeeded(current, meta, now);
  }

  async function runScheduledTaskOnce(
    task: ScheduledTask,
    appointment: Date,
    requestedByUser: boolean,
  ): Promise<ScheduledRunResult> {
    if (!task.ownerPluginId) {
      if (!options.runAgentTask) {
        throw new PluginScheduleError("ERR_UNAVAILABLE", "No agent run delegate configured");
      }
      return options.runAgentTask(task, appointment, requestedByUser);
    }

    const meta = findMetadataByAnyId(task.id);
    const v2TaskId = meta?.taskId ?? task.id;

    rearmCronTaskIfNeeded(task, meta, appointment);

    const risks = collectTaskRisks(task, meta);
    const blockingRisks = risks.filter((risk) => UNATTENDED_APPROVAL_RISKS.has(risk));

    if (!requestedByUser && blockingRisks.length > 0) {
      const suspended = createApprovalSuspension(task, v2TaskId, appointment, blockingRisks);
      return {
        ok: false,
        error: "pending_approval",
        historyId: suspended.runId,
        effectiveToolIds: [...task.allowedToolIds],
      };
    }

    return executeConfirmedAction(v2TaskId, task, meta, appointment, requestedByUser, `run-${nextId()}`);
  }

  function suspendUnattendedRun(
    taskId: string,
    risks: ToolRisk[],
    reason?: string,
  ): UnattendedApprovalRecord {
    ensureNonEmptyId(taskId, "taskId");
    const normalized = normalizeRisks(risks);
    const blocking = normalized.filter((risk) => UNATTENDED_APPROVAL_RISKS.has(risk));
    if (blocking.length === 0) {
      throw new PluginScheduleError(
        "ERR_INVALID_ARGUMENT",
        "Unattended approval suspension requires at least one privileged risk (fs-write, shell, input-control)",
      );
    }
    const task = findStoreTaskByAnyId(taskId);
    if (!task || !task.ownerPluginId) {
      throw new PluginScheduleError("ERR_INVALID_ARGUMENT", `Plugin task not found: ${taskId}`);
    }
    const meta = findMetadataByAnyId(taskId);
    return createApprovalSuspension(task, meta?.taskId ?? task.id, clock(), blocking, reason);
  }

  function listPendingRunApprovals(pluginId?: string): UnattendedApprovalRecord[] {
    return Object.values(state.approvals)
      .filter(
        (record) =>
          record.status === "pending_approval"
          && (pluginId === undefined || record.pluginId === pluginId),
      )
      .map((record) => cloneValue(record));
  }

  function getRunApproval(runId: string): UnattendedApprovalRecord | undefined {
    const record = state.approvals[runId];
    return record ? cloneValue(record) : undefined;
  }

  async function approveRun(
    runId: string,
  ): Promise<{ approval: UnattendedApprovalRecord; result: ScheduledRunResult }> {
    ensureNonEmptyId(runId, "runId");
    const record = state.approvals[runId];
    if (!record) {
      throw new PluginScheduleError("ERR_INVALID_ARGUMENT", `Run approval not found: ${runId}`);
    }
    if (record.status === "rejected") {
      throw new PluginScheduleError("ERR_REJECTED", `Run "${runId}" was already rejected`);
    }
    if (record.status === "cancelled") {
      throw new PluginScheduleError("ERR_CANCELLED", `Run "${runId}" was cancelled`);
    }
    if (record.status !== "pending_approval") {
      throw new PluginScheduleError(
        "ERR_INVALID_ARGUMENT",
        `Run "${runId}" is already settled with status "${record.status}"`,
      );
    }

    const task = findStoreTaskByAnyId(record.taskId);
    if (!task || task.ownerPluginId !== record.pluginId) {
      record.status = "cancelled";
      record.settledAt = clock().toISOString();
      persistState();
      throw new PluginScheduleError(
        "ERR_CANCELLED",
        `Plugin task "${record.taskId}" is no longer available`,
      );
    }

    // An approved run shares the task's exclusive slot with scheduled runs; while busy it stays pending.
    if (runningTasks.has(task.id)) {
      throw new PluginScheduleError("ERR_UNAVAILABLE", `Task "${record.taskId}" is running; approve again when it finishes`, { retryable: true });
    }
    runningTasks.add(task.id);
    record.status = "approved";
    try {
      persistState();
    } catch (failure) {
      runningTasks.delete(task.id);
      throw failure;
    }

    const meta = findMetadataByAnyId(record.taskId);
    try {
      const result = await executeConfirmedAction(
        record.taskId,
        task,
        meta,
        new Date(record.appointmentAt),
        true,
        runId,
      );
      // Another operation's failed save may have reloaded `state` while the action ran; settle the current record.
      const settled = state.approvals[runId] ?? record;
      settled.status = result.ok ? "completed" : "failed";
      if (!result.ok && result.error) {
        settled.error = result.error;
      }
      settled.settledAt = clock().toISOString();
      state.approvals[runId] = settled;
      persistState();
      return { approval: cloneValue(settled), result };
    } catch (failure) {
      const settled = state.approvals[runId] ?? record;
      settled.status = "failed";
      settled.error = failure instanceof Error ? failure.message : String(failure);
      settled.settledAt = clock().toISOString();
      state.approvals[runId] = settled;
      persistState();
      throw failure;
    } finally {
      runningTasks.delete(task.id);
    }
  }

  function rejectRun(runId: string, reason?: string): UnattendedApprovalRecord {
    ensureNonEmptyId(runId, "runId");
    const record = state.approvals[runId];
    if (!record) {
      throw new PluginScheduleError("ERR_INVALID_ARGUMENT", `Run approval not found: ${runId}`);
    }
    if (record.status === "rejected") {
      throw new PluginScheduleError("ERR_REJECTED", `Run "${runId}" was already rejected`);
    }
    if (record.status === "cancelled") {
      throw new PluginScheduleError("ERR_CANCELLED", `Run "${runId}" was cancelled`);
    }
    if (record.status !== "pending_approval") {
      throw new PluginScheduleError(
        "ERR_INVALID_ARGUMENT",
        `Run "${runId}" is already settled with status "${record.status}"`,
      );
    }

    const settledAt = clock().toISOString();
    record.status = "rejected";
    if (reason) record.reason = reason;
    record.settledAt = settledAt;
    persistState();

    const meta = findMetadataByAnyId(record.taskId);
    store.recordHistory({
      id: `${runId}-rejected`,
      taskId: meta?.storeTaskId ?? record.taskId,
      taskTitle: record.title,
      firedAt: record.appointmentAt,
      finishedAt: settledAt,
      status: "skipped",
      reason: reason ? `rejected: ${reason}` : "rejected",
      effectiveToolIds: [],
    });

    return cloneValue(record);
  }

  function uninstallPlugin(pluginId: string): {
    removedTasks: number;
    removedProposals: number;
    cancelledApprovals: number;
  } {
    const ownerPluginId = ensureNonEmptyId(pluginId, "pluginId");

    // Delete the scheduled tasks first: if that fails, keep every piece of plugin state so no task is left
    // running without its action metadata.
    let removedTasks: number;
    try {
      removedTasks = store.deleteTasksByOwner(ownerPluginId);
    } catch (cause) {
      throw new PluginScheduleError("ERR_INTERNAL", "Failed to delete the plugin's scheduled tasks", { cause });
    }

    let removedProposals = 0;
    for (const [proposalId, proposal] of Object.entries(state.proposals)) {
      if (proposal.pluginId === ownerPluginId) {
        delete state.proposals[proposalId];
        removedProposals++;
      }
    }

    for (const [taskId, meta] of Object.entries(state.metadata)) {
      if (meta.pluginId === ownerPluginId) {
        delete state.metadata[taskId];
      }
    }

    let cancelledApprovals = 0;
    for (const [runId, approval] of Object.entries(state.approvals)) {
      if (approval.pluginId === ownerPluginId) {
        if (approval.status === "pending_approval") {
          cancelledApprovals++;
        }
        delete state.approvals[runId];
      }
    }

    triggerListeners.delete(ownerPluginId);
    const controllers = activeTriggerControllers.get(ownerPluginId);
    if (controllers) {
      for (const controller of controllers) {
        controller.abort();
      }
      activeTriggerControllers.delete(ownerPluginId);
    }

    persistState();
    refreshEngine();

    return {
      removedTasks,
      removedProposals,
      cancelledApprovals,
    };
  }

  // The host creates this service before starting the scheduler engine, so overdue cron tasks are re-armed first.
  reconcileCronTasks();
  // The engine also stops a cron one-shot when it skips it (plugin not running, previous run still going).
  // Re-arm those whenever the task list changes; re-arming itself changes it, so guard against re-entry.
  let sweeping = false;
  store.onChange?.(() => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const meta of Object.values(state.metadata)) rearmCronStoppedDuringRun(meta.storeTaskId);
    } finally {
      sweeping = false;
    }
  });

  return {
    reconcileCronTasks,
    forPlugin,
    listPendingProposals,
    confirmProposal,
    rejectProposal,
    runScheduledTask,
    suspendUnattendedRun,
    listPendingRunApprovals,
    getRunApproval,
    approveRun,
    rejectRun,
    uninstallPlugin,
  };
}

export type PluginScheduleService = ReturnType<typeof createPluginScheduleService>;
