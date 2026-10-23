import type { TaskTraceRecord } from "../../shared/task-session";
import type { TaskSessionStore } from "../tasks/task-session-store";

/** Streaming reasoning deltas are observation data: they are saved in batches instead of one task rewrite each. */
export const TASK_TRACE_BATCH_LIMIT = 64;
const TASK_TRACE_PENDING_CAP = 2000;

/**
 * Buffers consecutive reasoning deltas of a child run and appends them in one task checkpoint.
 * Every other trace record (round, tool, todo, terminal, reasoning start/end) is appended together
 * with the buffered deltas immediately, so record order and content match the unbuffered behaviour.
 * An uncontrolled process exit loses at most the deltas buffered since the last flush.
 */
export function createTaskTraceBuffer(store: Pick<TaskSessionStore, "get" | "checkpoint">, taskId: string, batchLimit = TASK_TRACE_BATCH_LIMIT) {
  const pending: TaskTraceRecord[] = [];
  function flush(): void {
    if (pending.length === 0) return;
    const current = store.get(taskId);
    // The task is gone: nothing can be saved, so do not keep the records.
    if (!current) { pending.length = 0; return; }
    // Records leave the buffer only after the checkpoint succeeded; a failed write keeps them for the next flush.
    store.checkpoint(taskId, { trace: [...current.trace, ...pending] });
    pending.length = 0;
  }
  return {
    add(record: TaskTraceRecord): void {
      pending.push(record);
      // A write that keeps failing must not grow memory without bound; the store keeps only this many records anyway.
      if (pending.length > TASK_TRACE_PENDING_CAP) pending.splice(0, pending.length - TASK_TRACE_PENDING_CAP);
      if (record.kind !== "reasoning" || record.phase !== "delta" || pending.length >= batchLimit) flush();
    },
    flush,
    /** Number of records not yet saved. */
    get size(): number { return pending.length; },
  };
}
