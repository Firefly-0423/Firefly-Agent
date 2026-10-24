import type { FileVersionEvidence, ModelExecutionEvent, TaskWriteEvidence, TaskWriteState } from "./agent-execution-evidence";
import type { ToolTaskResult } from "./chat-types";
import type { TaskSessionStatus } from "./task-session";

const statuses = new Set<TaskSessionStatus>(["running", "completed", "failed", "cancelled", "interrupted"]);
const writeStates = new Set<TaskWriteState>(["applied", "partially_applied", "unknown", "not_applied"]);
const DISPLAY_LIMIT = 64_000;
const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const identifier = (value: unknown): value is string => typeof value === "string" && !!value.trim() && !/[\0\r\n]/.test(value);

function normalizeVersion(value: unknown): FileVersionEvidence | undefined {
  const record = recordOf(value);
  if (!record || (record.sha256 !== undefined && (typeof record.sha256 !== "string" || !/^[a-f\d]{64}$/i.test(record.sha256)))
    || (record.version !== undefined && !identifier(record.version))) return undefined;
  return {
    ...(typeof record.sha256 === "string" ? { sha256: record.sha256 } : {}),
    ...(typeof record.version === "string" ? { version: record.version } : {}),
  };
}

function normalizeWrite(value: unknown, agentId: string): TaskWriteEvidence | undefined {
  const record = recordOf(value);
  if (!record || !identifier(record.path) || !identifier(record.canonicalPath) || record.agentId !== agentId
    || !identifier(record.childRunId) || !identifier(record.toolCallId)
    || typeof record.state !== "string" || !writeStates.has(record.state as TaskWriteState)
    || !Array.isArray(record.eventIds) || !record.eventIds.every(identifier)) return undefined;
  const before = record.before === undefined ? undefined : normalizeVersion(record.before);
  const after = record.after === undefined ? undefined : normalizeVersion(record.after);
  if ((record.before !== undefined && !before) || (record.after !== undefined && !after)) return undefined;
  return {
    path: record.path, canonicalPath: record.canonicalPath, agentId,
    childRunId: record.childRunId, toolCallId: record.toolCallId, state: record.state as TaskWriteState,
    ...(before ? { before } : {}), ...(after ? { after } : {}), eventIds: [...record.eventIds],
  };
}

function normalizeExecutionEvent(value: unknown, agentId: string, parentRunId?: string): ModelExecutionEvent | undefined {
  const record = recordOf(value);
  if (!record || !identifier(record.id) || !Number.isSafeInteger(record.seq) || (record.seq as number) < 1
    || typeof record.monotonicMs !== "number" || !Number.isFinite(record.monotonicMs) || record.monotonicMs < 0
    || !identifier(record.clockDomainId) || record.agentId !== agentId || !identifier(record.parentRunId)
    || (parentRunId !== undefined && record.parentRunId !== parentRunId)
    || !identifier(record.childRunId) || !identifier(record.executionId)
    || !["start", "end", "terminal"].includes(record.phase as string)
    || (record.terminal !== undefined && !["completed", "failed", "cancelled"].includes(record.terminal as string))) return undefined;
  return {
    id: record.id, seq: record.seq as number, monotonicMs: record.monotonicMs,
    clockDomainId: record.clockDomainId, agentId, parentRunId: record.parentRunId,
    childRunId: record.childRunId, executionId: record.executionId, phase: record.phase as ModelExecutionEvent["phase"],
    ...(record.terminal !== undefined ? { terminal: record.terminal as ModelExecutionEvent["terminal"] } : {}),
  };
}

/** Whitelist runtime facts at live and restored presentation boundaries. Never infer facts from prose. */
export function normalizeToolTaskResult(value: unknown, parentRunId?: string): ToolTaskResult | undefined {
  const record = recordOf(value);
  if (!record || !identifier(record.agentId) || !identifier(record.sessionId)
    || typeof record.status !== "string" || !statuses.has(record.status as TaskSessionStatus)
    || typeof record.text !== "string" || (record.truncated !== undefined && typeof record.truncated !== "boolean")) return undefined;
  let writes: TaskWriteEvidence[] | undefined;
  if (record.writes !== undefined) {
    if (!Array.isArray(record.writes)) return undefined;
    const normalized = record.writes.map(value => normalizeWrite(value, record.agentId as string));
    if (normalized.some(value => !value)) return undefined;
    writes = normalized as TaskWriteEvidence[];
  }
  let executionEvents: ModelExecutionEvent[] | undefined;
  if (record.executionEvents !== undefined) {
    if (!Array.isArray(record.executionEvents)) return undefined;
    const normalized = record.executionEvents.map(value => normalizeExecutionEvent(value, record.agentId as string, parentRunId));
    if (normalized.some(value => !value)) return undefined;
    executionEvents = normalized as ModelExecutionEvent[];
  }
  // A task result contains one child invocation. Do not attach a different child's writes to it.
  const childRunId = executionEvents?.[0]?.childRunId ?? writes?.[0]?.childRunId;
  if (childRunId && (executionEvents?.some(event => event.childRunId !== childRunId)
    || writes?.some(write => write.childRunId !== childRunId))) return undefined;
  let error: ToolTaskResult["error"];
  if (record.error !== undefined) {
    const candidate = recordOf(record.error);
    if (!candidate || !identifier(candidate.code) || typeof candidate.message !== "string") return undefined;
    error = { code: candidate.code, message: candidate.message };
  }
  return {
    agentId: record.agentId, sessionId: record.sessionId, status: record.status as TaskSessionStatus,
    text: record.text.slice(0, DISPLAY_LIMIT),
    ...(record.text.length > DISPLAY_LIMIT || record.truncated === true ? { truncated: true } : {}),
    ...(writes ? { writes } : {}), ...(executionEvents ? { executionEvents } : {}), ...(error ? { error } : {}),
  };
}
