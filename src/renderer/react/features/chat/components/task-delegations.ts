import type { TaskDelegationDisplayRecord } from "../../../../../shared/chat-types";
import type { TaskDelegationPresentation } from "../../../../../shared/task-session";
import { TASK_CHARACTERS } from "../../../../../shared/task-characters";

export function normalizeTaskDelegationEvent(value: unknown): TaskDelegationPresentation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<TaskDelegationPresentation>;
  if (typeof candidate.invocationId !== "string" || !candidate.invocationId) return undefined;
  if (typeof candidate.taskId !== "string" || !candidate.taskId) return undefined;
  if (typeof candidate.description !== "string" || !candidate.description.trim()) return undefined;
  if (typeof candidate.nickname !== "string" || typeof candidate.assetFileName !== "string") return undefined;
  if (!TASK_CHARACTERS.some((avatar) => avatar.nickname === candidate.nickname && avatar.assetFileName === candidate.assetFileName)) return undefined;
  const state = candidate.status;
  if (state !== "running" && state !== "completed" && state !== "failed" && state !== "cancelled") return undefined;
  return {
    invocationId: candidate.invocationId, taskId: candidate.taskId,
    description: candidate.description.trim(), nickname: candidate.nickname,
    assetFileName: candidate.assetFileName, status: state,
  };
}

export function applyTaskDelegationEvent(records: readonly TaskDelegationDisplayRecord[], event: TaskDelegationPresentation, roundId?: string): TaskDelegationDisplayRecord[] {
  const found = records.findIndex((entry) => entry.invocationId === event.invocationId);
  if (found < 0) return [...records, { ...event, roundId }];
  if (records[found].status !== "running" && event.status === "running") return [...records];
  return records.map((entry, offset) => {
    if (offset !== found) return entry;
    return { ...entry, ...event, roundId: entry.roundId ?? roundId };
  });
}
