import { IPC } from "../../../shared/ipc-channels";
import type { IpcScope } from "../../base/ipc/ipc-scope";
import type { Schedule, ScheduleAction, ScheduleProposal, TaskRecord } from "../../../plugins/v2/schedules/types";

/** The part of the plugin schedule service the proposal IPC needs. */
export interface PluginProposalService {
  listPendingProposals(): ScheduleProposal[];
  getTaskRecord(taskId: string): TaskRecord | undefined;
  confirmProposal(taskId: string): unknown;
  rejectProposal(taskId: string): unknown;
}

/** What a pending change would replace; only present for `update` proposals whose task still exists. */
export interface PluginProposalCurrent {
  title: string;
  schedule: Schedule;
  action: ScheduleAction;
  allowedToolIds: string[];
}

/** A pending proposal as the renderer sees it. */
export interface PluginProposalView {
  proposalId: string;
  taskId: string;
  pluginId: string;
  /** Manifest name; the plugin id when the plugin is no longer installed. */
  pluginName: string;
  kind: ScheduleProposal["kind"];
  title: string;
  schedule: Schedule;
  action: ScheduleAction;
  allowedToolIds: string[];
  createdAt: string;
  current?: PluginProposalCurrent;
}

export type PluginProposalIpcResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: string; /** Stable PluginError code, e.g. ERR_REJECTED or ERR_INVALID_ARGUMENT. */ code?: string };

function failure(err: unknown): PluginProposalIpcResult<never> {
  const code = (err as { code?: unknown } | null)?.code;
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    ...(typeof code === "string" ? { code } : {}),
  };
}

function describeProposal(
  service: PluginProposalService,
  proposal: ScheduleProposal,
  resolvePluginName: (pluginId: string) => string | undefined,
): PluginProposalView {
  const existing = proposal.kind === "update" ? service.getTaskRecord(proposal.taskId) : undefined;
  const current = existing && existing.pluginId === proposal.pluginId
    ? { title: existing.title, schedule: existing.schedule, action: existing.action, allowedToolIds: existing.allowedToolIds }
    : undefined;
  return {
    proposalId: proposal.proposalId,
    taskId: proposal.taskId,
    pluginId: proposal.pluginId,
    pluginName: resolvePluginName(proposal.pluginId) ?? proposal.pluginId,
    kind: proposal.kind,
    title: proposal.spec.title,
    schedule: proposal.spec.schedule,
    action: proposal.spec.action,
    allowedToolIds: proposal.spec.allowedToolIds ?? [],
    createdAt: proposal.createdAt,
    ...(current ? { current } : {}),
  };
}

/**
 * Registers the IPC that lets the user review plugin schedule proposals.
 * A proposal takes effect only when `confirm` succeeds; errors keep their stable PluginError code.
 */
export function registerPluginProposalIpc(
  ipc: IpcScope,
  service: PluginProposalService,
  resolvePluginName: (pluginId: string) => string | undefined = () => undefined,
): void {
  ipc.handle(IPC.SCHEDULER_PLUGIN_PROPOSALS_LIST, (): PluginProposalIpcResult<PluginProposalView[]> => {
    try {
      return { ok: true, value: service.listPendingProposals().map((p) => describeProposal(service, p, resolvePluginName)) };
    } catch (err) {
      return failure(err);
    }
  });

  ipc.handle(IPC.SCHEDULER_PLUGIN_PROPOSALS_CONFIRM, (_event, taskId: string): PluginProposalIpcResult => {
    try {
      service.confirmProposal(taskId);
      return { ok: true, value: true };
    } catch (err) {
      return failure(err);
    }
  });

  ipc.handle(IPC.SCHEDULER_PLUGIN_PROPOSALS_REJECT, (_event, taskId: string): PluginProposalIpcResult => {
    try {
      service.rejectProposal(taskId);
      return { ok: true, value: true };
    } catch (err) {
      return failure(err);
    }
  });
}
