import * as path from "path";
import { createHash, randomUUID } from "crypto";
import type { ToolContext } from "./tool-context";
import type { FileVersionEvidence, TaskWriteEvidence, TaskWriteState } from "../../../../shared/agent-execution-evidence";
import { canonicalWriteIdentity, observedWriteIdentity } from "../../harness/write-ownership";
import { ToolExecutionError } from "./tool-execution-error";
import type { WorkspaceSnapshot } from "../workspace-handle";
import { readWorkspaceReviewSource } from "../../review/workspace-review-source";
import { reviewTrackerFor } from "../../review/review-tracker-access";

/** Trusted native observations only. An unavailable after-image stays unknown;
 * it must never trigger a path-based read as a fallback. */
export interface WriteBatchObservations {
  before(file: string): WorkspaceSnapshot | undefined;
  after(file: string): WorkspaceSnapshot | undefined;
}
export function snapshotVersion(snapshot: WorkspaceSnapshot | undefined): FileVersionEvidence | undefined {
  if (!snapshot) return undefined;
  if (!snapshot.exists) return { version: "absent" };
  return snapshot.bytes ? { sha256: createHash("sha256").update(snapshot.bytes).digest("hex"), version: "present" } : undefined;
}

/** Hash actual bytes, never intended text or a preview diff. */
function fileVersion(file: string, context?: ToolContext, observed?: (snapshot: WorkspaceSnapshot | undefined) => void): FileVersionEvidence | undefined {
  try {
    // This API is synchronous. If a formerly unrestricted mutation is downgraded
    // before observation, omit its version rather than reopening the path.
    const snapshot = readWorkspaceReviewSource(file, context, Infinity, "write");
    observed?.(snapshot);
    return snapshotVersion(snapshot);
  } catch {
    observed?.(undefined);
    return undefined;
  }
}
function clone(item: TaskWriteEvidence): TaskWriteEvidence {
  return { ...item, ...(item.before ? { before: { ...item.before } } : {}), ...(item.after ? { after: { ...item.after } } : {}), eventIds: [...item.eventIds] };
}
function failureState(before?: FileVersionEvidence, after?: FileVersionEvidence): TaskWriteState {
  if (!before || !after) return "unknown";
  if (before.sha256 !== after.sha256 || before.version !== after.version) return "partially_applied";
  // Equal bytes do not prove that a started mutation had no effect: it may
  // rewrite the same bytes, change metadata, or write and restore them.
  return "unknown";
}

export interface WriteBatch {
  run<T>(paths: readonly string[], mutate: () => T | Promise<T>): Promise<T>;
  /** Existing synchronous patch engine keeps its public API; same evidence semantics. */
  runSync<T>(paths: readonly string[], mutate: () => T): T;
  finish(): TaskWriteEvidence[];
}

/** Call only after approval and full path/input prevalidation, before any mutation. */
export function beginWriteBatch(context: ToolContext | undefined, paths: readonly string[], observations?: WriteBatchObservations): WriteBatch {
  const execution = context?.execution;
  const entries = new Map<string, TaskWriteEvidence>();
  const resolved = [...new Set(paths.map((file) => path.resolve(file)))];
  if (execution) {
    if (!execution.permit) throw new Error("File mutation requires an active leaf permit");
    const scope = execution.coordinator.assertPermit(execution.permit, "exclusive");
    const observedPaths = observations ? resolved.map(file => {
      const name = observations.before(file)?.canonicalPath;
      if (!name) throw new ToolExecutionError("E_WORKSPACE_BOUNDARY", "Missing native write identity", "permission_denied");
      return observedWriteIdentity(name);
    }) : undefined;
    // Claim is atomic across all paths, including rename destinations. A failed
    // claim publishes no records and performs no write.
    if (observedPaths) execution.coordinator.writeOwnership.claim(execution.permit, resolved, observedPaths);
    else execution.coordinator.writeOwnership.claim(execution.permit, resolved);
    for (const [index, file] of resolved.entries()) {
      const canonicalPath = observedPaths ? observedPaths[index] : canonicalWriteIdentity(file);
      const before = observations ? snapshotVersion(observations.before(file)) : fileVersion(file, context);
      const item: TaskWriteEvidence = {
        path: file, canonicalPath,
        agentId: scope.agentId, childRunId: scope.childRunId, toolCallId: scope.toolCallId,
        state: "not_applied", ...(before ? { before, after: { ...before } } : {}), eventIds: [randomUUID()],
      };
      // Content ownership is canonical; evidence stays per actual operation
      // path because deleting a symlink does not delete its target.
      entries.set(file, item);
      execution.coordinator.recordWriteEvidence(execution.permit, clone(item));
    }
  }
  const publish = (item: TaskWriteEvidence) => {
    if (execution?.permit) execution.coordinator.recordWriteEvidence(execution.permit, clone(item));
  };
  const start = (files: readonly string[]) => {
    const targets = [...new Set(files.map((file) => path.resolve(file)))];
    for (const file of targets) {
      if (!resolved.includes(file)) throw new Error(`Mutation path was not included in validated write batch: ${file}`);
    }
    const selected = [...new Set(targets.map((file) => entries.get(file)).filter((item): item is TaskWriteEvidence => Boolean(item)))];
    for (const item of selected) { item.state = "unknown"; item.eventIds.push(randomUUID()); delete item.after; publish(item); }
    return selected;
  };
  const settle = (selected: TaskWriteEvidence[], success: boolean, files: readonly string[]) => {
    const sources = new Map<string, WorkspaceSnapshot | undefined>();
    for (const item of selected) {
      const after = observations ? snapshotVersion(observations.after(item.path)) : fileVersion(item.path, context, snapshot => sources.set(item.path, snapshot));
      if (after) item.after = after;
      else delete item.after;
      item.state = success ? "applied" : failureState(item.before, after);
      item.eventIds.push(randomUUID());
    }
    // Observe all actual after-versions before any subscriber can throw. The
    // coordinator stores each fact before notifying its persistence listeners.
    let publicationFailed = false;
    let firstPublicationError: unknown;
    for (const item of selected) {
      try { publish(item); }
      catch (error) {
        if (!publicationFailed) firstPublicationError = error;
        publicationFailed = true;
      }
    }
    if (context?.runId) {
      const tracker = reviewTrackerFor();
      for (const file of new Set(files.map(f => path.resolve(f)))) {
        try {
          tracker.recordAfterBatch(context.runId, file, () => observations ? observations.after(file)
            : sources.has(file) ? sources.get(file) : readWorkspaceReviewSource(file, context, Infinity, "write"));
        } catch (error) {
          if (!publicationFailed) firstPublicationError = error;
          publicationFailed = true;
        }
      }
    }
    if (publicationFailed) throw firstPublicationError;
  };
  return {
    async run<T>(files: readonly string[], mutate: () => T | Promise<T>): Promise<T> {
      const selected = start(files);
      let value: T;
      try { value = await mutate(); }
      catch (error) {
        // An evidence-store failure must not replace the original mutation error.
        try { settle(selected, false, files); } catch { /* Facts stay in the coordinator. */ }
        throw error;
      }
      // Post-mutation publication failure does not change actual applied facts.
      settle(selected, true, files);
      return value;
    },
    runSync<T>(files: readonly string[], mutate: () => T): T {
      const selected = start(files);
      let value: T;
      try { value = mutate(); }
      catch (error) {
        try { settle(selected, false, files); } catch { /* Preserve the mutation error. */ }
        throw error;
      }
      settle(selected, true, files);
      return value;
    },
    finish: () => [...entries.values()].map(clone),
  };
}

/** Independent trusted channel. Never consume model/legacy JSON for write facts. */
export function getToolWriteEvidence(context?: ToolContext): TaskWriteEvidence[] {
  const execution = context?.execution;
  return execution ? execution.coordinator.getWriteEvidence({
    childRunId: execution.scope.childRunId, toolCallId: execution.scope.toolCallId,
  }) : [];
}
