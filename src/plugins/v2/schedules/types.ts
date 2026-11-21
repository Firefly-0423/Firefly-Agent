import type {
  NewScheduledTaskInput,
  ScheduledRunResult,
  ScheduledTask,
  ScheduledTaskHistoryEntry,
  ScheduledTaskPatch,
} from "../../../main/platform/schedule/schedule-types";

export type Mode = "chat" | "work" | "code";

export type ToolRisk = "fs-read" | "fs-write" | "shell" | "network" | "input-control";

export const UNATTENDED_APPROVAL_RISKS: ReadonlySet<ToolRisk> = new Set<ToolRisk>([
  "fs-write",
  "shell",
  "input-control",
]);

export type PluginErrorCode =
  | "ERR_UNDECLARED"
  | "ERR_PERMISSION"
  | "ERR_REJECTED"
  | "ERR_CANCELLED"
  | "ERR_TIMEOUT"
  | "ERR_INVALID_ARGUMENT"
  | "ERR_RATE_LIMITED"
  | "ERR_UNAVAILABLE"
  | "ERR_INTERNAL";

export class PluginScheduleError extends Error {
  readonly code: PluginErrorCode;
  readonly retryable: boolean;

  constructor(
    code: PluginErrorCode,
    message: string,
    options?: { retryable?: boolean; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "PluginScheduleError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

export type Schedule =
  | { kind: "cron"; expression: string; timezone?: string }
  | { kind: "once"; at: number }
  | { kind: "interval"; minutes: number };

export type ScheduleAction =
  | { type: "run"; prompt: string; mode: Mode }
  | { type: "callback"; payload?: unknown };

export interface ScheduleProposalSpec {
  title: string;
  schedule: Schedule;
  action: ScheduleAction;
  /** Optional tool risks declared for host-side unattended approval gating. */
  requiredRisks?: ToolRisk[];
  /** Optional explicit tool allowlist for "run" actions. */
  allowedToolIds?: string[];
}

export type ScheduleProposalKind = "create" | "update";

export type ScheduleProposalStatus = "pending_approval" | "confirmed" | "rejected";

export interface ScheduleProposal {
  proposalId: string;
  taskId: string;
  pluginId: string;
  kind: ScheduleProposalKind;
  status: ScheduleProposalStatus;
  spec: ScheduleProposalSpec;
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus = "pending_approval" | "active" | "paused";

export interface TaskRecord {
  taskId: string;
  pluginId: string;
  title: string;
  schedule: Schedule;
  action: ScheduleAction;
  status: TaskStatus;
  requiredRisks: ToolRisk[];
  allowedToolIds: string[];
  nextFireAt: string | null;
  lastFiredAt?: string;
  createdAt: string;
  updatedAt: string;
  pendingProposalId?: string;
  pendingApprovalRunId?: string;
}

export type UnattendedApprovalStatus =
  | "pending_approval"
  | "approved"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled";

export interface UnattendedApprovalRecord {
  runId: string;
  taskId: string;
  pluginId: string;
  title: string;
  appointmentAt: string;
  status: UnattendedApprovalStatus;
  requiredRisks: ToolRisk[];
  reason?: string;
  error?: string;
  createdAt: string;
  settledAt?: string;
}

export interface UnattendedApprovalNotification {
  runId: string;
  taskId: string;
  pluginId: string;
  title: string;
  requiredRisks: ToolRisk[];
  reason?: string;
}

export interface TriggerEvent {
  taskId: string;
  payload?: unknown;
  signal: AbortSignal;
}

export interface Disposable {
  dispose(): void;
}

export interface PluginSchedulesClient {
  propose(spec: ScheduleProposalSpec): Promise<{ taskId: string; status: "pending_approval" }>;
  update(
    taskId: string,
    patch: Partial<ScheduleProposalSpec>,
  ): Promise<{ status: "pending_approval" }>;
  remove(taskId: string): Promise<boolean>;
  list(): Promise<TaskRecord[]>;
  onTrigger(fn: (event: TriggerEvent) => Promise<void> | void): Disposable;
}

/**
 * Port to the existing scheduler store layer (`src/main/features/scheduler/scheduler-store.ts`).
 * `SchedulerEngine` observes changes on this store via `onChange` to rearm timers.
 */
export interface PluginSchedulerStorePort {
  getTasks(): ScheduledTask[];
  addTask(input: NewScheduledTaskInput): ScheduledTask;
  updateTask(id: string, patch: ScheduledTaskPatch): ScheduledTask;
  deleteTask(id: string): boolean;
  deleteTasksByOwner(ownerId: string): number;
  recordHistory(entry: ScheduledTaskHistoryEntry): void;
  getHistory(taskId: string, limit?: number): ScheduledTaskHistoryEntry[];
  onChange?(listener: (tasks: ScheduledTask[]) => void): () => void;
}

export interface PluginScheduleServiceOptions {
  store: PluginSchedulerStorePort;
  /** Optional path to persist proposals, v2 metadata, and pending unattended approvals atomically. */
  stateFile?: string;
  /** Delegate for executing `{ type: "run" }` tasks (e.g., `SchedulerRunner.runScheduledTask`). */
  runAgentTask?: (
    task: ScheduledTask,
    appointment: Date,
    requestedByUser: boolean,
  ) => Promise<ScheduledRunResult>;
  /** Optional hook to notify `SchedulerEngine.refreshPluginTasks()` after bulk uninstall cleanup. */
  refreshEngine?: () => void;
  /** Desktop notification hook invoked when an unattended run suspends as `pending_approval`. */
  notifyApprovalRequired?: (notification: UnattendedApprovalNotification) => void;
  /** Resolves additional tool risks for a scheduled task (e.g., from tool registry metadata). */
  resolveTaskRisks?: (task: ScheduledTask) => ToolRisk[];
  /** Optional clock override for deterministic tests. */
  now?: () => Date;
  /** Optional id generator override for deterministic tests. */
  id?: () => string;
}

export interface PluginClientOptions {
  /** Optional abort signal triggered when the plugin stops or is deactivated. */
  signal?: AbortSignal;
  /** Optional permission check reflecting whether `"schedules"` permission is currently granted. */
  hasPermission?: () => boolean;
}
