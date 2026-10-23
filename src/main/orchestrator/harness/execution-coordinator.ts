import type { FileVersionEvidence, TaskWriteEvidence } from "../../../shared/agent-execution-evidence";
import { ToolExecutionError } from "../tools/registry/tool-execution-error";
import { canonicalWriteIdentity, WriteOwnership } from "./write-ownership";

/** Trusted Main identity. Never populated from a model's tool arguments. */
export interface ExecutionScope {
  workspaceId: string;
  parentRunId: string;
  groupId: string;
  agentId: string;
  childRunId: string;
  toolCallId: string;
}
export type LeafExecutionMode = "shared" | "exclusive";

declare const leafPermit: unique symbol;
/** Only runLeaf can mint a live capability; structural casts cannot pass runtime validation. */
export interface LeafPermit { readonly [leafPermit]: true }

interface GroupState {
  parentRunId: string;
  state: "open" | "closing" | "closed";
  operations: Set<ActiveOperation>;
  closePromise?: Promise<void>;
}
interface ActiveOperation {
  permit: LeafPermit;
  scope: Readonly<ExecutionScope>;
  mode: LeafExecutionMode;
  pendingLifetimes: number;
  acceptingLifetimes: boolean;
}
interface QueuedLeaf {
  scope: Readonly<ExecutionScope>;
  mode: LeafExecutionMode;
  signal?: AbortSignal;
  removeAbortListener: () => void;
  start: (operation: ActiveOperation) => void;
  reject: (error: unknown) => void;
}
interface DrainWaiter {
  settled: () => boolean;
  resolve: () => void;
}
export interface WriteEvidenceFilter { groupId?: string; childRunId?: string; toolCallId?: string }

function executionError(code: string, message: string): ToolExecutionError {
  return new ToolExecutionError(code, message, "runtime_safety", false, "not_applied");
}
function aborted(): Error {
  const error = new Error("Leaf execution cancelled before it started");
  error.name = "AbortError";
  return error;
}
function cloneVersion(version: FileVersionEvidence): FileVersionEvidence {
  return { ...(version.sha256 !== undefined ? { sha256: version.sha256 } : {}), ...(version.version !== undefined ? { version: version.version } : {}) };
}
function cloneWrite(write: TaskWriteEvidence): TaskWriteEvidence {
  return {
    path: write.path, canonicalPath: write.canonicalPath, agentId: write.agentId,
    childRunId: write.childRunId, toolCallId: write.toolCallId, state: write.state,
    ...(write.before ? { before: cloneVersion(write.before) } : {}),
    ...(write.after ? { after: cloneVersion(write.after) } : {}), eventIds: [...write.eventIds],
  };
}
function validWrite(write: TaskWriteEvidence): boolean {
  const validVersion = (version: FileVersionEvidence | undefined) => version === undefined || (version !== null && typeof version === "object" && (version.sha256 === undefined || (typeof version.sha256 === "string" && /^[a-f0-9]{64}$/i.test(version.sha256))) && (version.version === undefined || typeof version.version === "string"));
  return write !== null && typeof write === "object" && [write.path, write.canonicalPath, write.agentId, write.childRunId, write.toolCallId].every(value => typeof value === "string" && value.length > 0) && ["applied", "partially_applied", "unknown", "not_applied"].includes(write.state) && Array.isArray(write.eventIds) && write.eventIds.every(id => typeof id === "string") && validVersion(write.before) && validVersion(write.after);
}

/** One process-local FIFO read/write queue for one canonical workspace. */
export class RunExecutionCoordinator {
  readonly writeOwnership = new WriteOwnership(this);
  private readonly groups = new Map<string, GroupState>();
  private readonly queue: QueuedLeaf[] = [];
  private readonly permits = new WeakMap<LeafPermit, ActiveOperation>();
  private readonly active = new Set<ActiveOperation>();
  private readonly drainWaiters = new Set<DrainWaiter>();
  private readonly childFailures = new Map<string, ToolExecutionError>();
  private readonly terminationListeners = new Map<string, Set<(error: ToolExecutionError) => void>>();
  private readonly writes = new Map<string, { groupId: string; evidence: TaskWriteEvidence }>();
  private readonly writeListeners = new Map<string, Set<(writes: TaskWriteEvidence[]) => void>>();
  private activeReaders = 0;
  private activeWriter = false;
  private pumping = false;

  constructor(readonly workspaceId: string) {}

  runLeaf<T>(scope: ExecutionScope, mode: LeafExecutionMode, signal: AbortSignal | undefined, execute: (permit: LeafPermit) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      try {
        this.validateScope(scope);
        if (mode !== "shared" && mode !== "exclusive") throw executionError("AGENT_EXECUTION_SCOPE_INVALID", "Invalid leaf execution mode");
        const failure = this.childFailures.get(scope.childRunId);
        if (failure) throw failure;
        if (signal?.aborted) throw aborted();
        let group = this.groups.get(scope.groupId);
        if (group?.state !== undefined && group.state !== "open") throw this.groupClosed(scope.groupId);
        if (group && group.parentRunId !== scope.parentRunId) throw executionError("AGENT_EXECUTION_SCOPE_INVALID", "Group belongs to a different parent run");
        if (!group) {
          group = { parentRunId: scope.parentRunId, state: "open", operations: new Set() };
          this.groups.set(scope.groupId, group);
        }
        const trustedScope = Object.freeze({ ...scope });
        const entry: QueuedLeaf = {
          scope: trustedScope, mode, signal, removeAbortListener: () => undefined, reject,
          start: operation => {
            // Invoke synchronously after minting the permit. No cancellation race may run
            // a body whose queued entry has already been rejected.
            let actual: Promise<T>;
            try { actual = Promise.resolve(execute(operation.permit)); }
            catch (error) { actual = Promise.reject(error); }
            void actual.then(
              result => { operation.acceptingLifetimes = false; this.completeLifetime(operation); resolve(result); },
              error => { operation.acceptingLifetimes = false; this.completeLifetime(operation); reject(error); },
            );
          },
        };
        if (signal) {
          const onAbort = () => {
            const index = this.queue.indexOf(entry);
            if (index < 0) return; // Abort is not proof that an active operation stopped.
            this.queue.splice(index, 1); entry.removeAbortListener(); reject(aborted());
            this.pump(); this.notifyDrains();
          };
          signal.addEventListener("abort", onAbort, { once: true });
          entry.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        }
        this.queue.push(entry);
        this.pump();
      } catch (error) { reject(error); }
    });
  }

  /** Extend the genuine operation lifetime, e.g. a spawned job's actual close event.
   * Call while the original body is still pending; a finished body cannot add work. */
  retainUntil(permit: LeafPermit, actualCompletion: Promise<unknown>): void {
    this.assertPermit(permit);
    const operation = this.permits.get(permit)!;
    if (!operation.acceptingLifetimes) throw executionError("AGENT_EXECUTION_PERMIT_INVALID", "Leaf permit no longer accepts operation lifetimes");
    operation.pendingLifetimes++;
    // Both branches consume the settlement. A failed retained process must not create
    // a floating rejection or replace the original tool body's result/error.
    void Promise.resolve(actualCompletion).then(
      () => this.completeLifetime(operation),
      () => this.completeLifetime(operation),
    );
  }

  assertPermit(permit: LeafPermit, requiredMode?: LeafExecutionMode): Readonly<ExecutionScope> {
    const operation = this.permits.get(permit);
    if (!operation || !this.active.has(operation)) throw executionError("AGENT_EXECUTION_PERMIT_INVALID", "Invalid or expired leaf permit");
    if (requiredMode && operation.mode !== requiredMode) throw executionError("AGENT_EXECUTION_PERMIT_INVALID", `An active ${requiredMode} leaf permit is required`);
    return operation.scope;
  }

  whenSettled(groupId: string): Promise<void> {
    return this.waitFor(() => (this.groups.get(groupId)?.operations.size ?? 0) === 0);
  }
  whenChildSettled(childRunId: string): Promise<void> {
    return this.waitFor(() => ![...this.active].some(operation => operation.scope.childRunId === childRunId));
  }

  /** Final group boundary. Cancel work that never started, then drain actual work. */
  closeGroup(groupId: string): Promise<void> {
    let group = this.groups.get(groupId);
    if (!group) {
      group = { parentRunId: "", state: "closed", operations: new Set(), closePromise: Promise.resolve() };
      this.groups.set(groupId, group);
      return group.closePromise!;
    }
    if (group.closePromise) return group.closePromise;
    group.state = "closing";
    this.rejectQueued(entry => entry.scope.groupId === groupId, this.groupClosed(groupId));
    group.closePromise = this.whenSettled(groupId).then(() => {
      this.writeOwnership.releaseGroup(groupId);
      group!.state = "closed";
    });
    return group.closePromise;
  }

  /** Conflict is local to a child, including its future Shell calls. */
  terminateChild(childRunId: string, code: "AGENT_WRITE_CONFLICT", failure?: ToolExecutionError): void {
    if (this.childFailures.has(childRunId)) return;
    const error = failure ?? new ToolExecutionError(code, "Child execution stopped after a conflicting write claim", "fatal", false, "not_applied");
    this.childFailures.set(childRunId, error);
    this.rejectQueued(entry => entry.scope.childRunId === childRunId, error);
    for (const listener of this.terminationListeners.get(childRunId) ?? []) listener(error);
  }
  getChildFailure(childRunId: string): ToolExecutionError | undefined { return this.childFailures.get(childRunId); }
  onChildTerminated(childRunId: string, listener: (error: ToolExecutionError) => void): () => void {
    const listeners = this.terminationListeners.get(childRunId) ?? new Set();
    listeners.add(listener); this.terminationListeners.set(childRunId, listeners);
    const failure = this.childFailures.get(childRunId);
    if (failure) listener(failure);
    return () => { listeners.delete(listener); if (listeners.size === 0) this.terminationListeners.delete(childRunId); };
  }

  recordWriteEvidence(permit: LeafPermit, evidence: TaskWriteEvidence): void {
    const scope = this.assertPermit(permit, "exclusive");
    if (!validWrite(evidence)) throw executionError("AGENT_EXECUTION_SCOPE_INVALID", "Invalid write evidence");
    if (evidence.agentId !== scope.agentId || evidence.childRunId !== scope.childRunId || evidence.toolCallId !== scope.toolCallId) {
      throw executionError("AGENT_EXECUTION_SCOPE_INVALID", "Write evidence does not belong to this leaf permit");
    }
    // Different actual operations can share one canonical ownership identity (e.g.
    // deleting an alias symlink, then updating its target). Keep both path facts.
    const key = JSON.stringify([scope.groupId, evidence.childRunId, evidence.toolCallId, evidence.canonicalPath, evidence.path]);
    this.writes.set(key, { groupId: scope.groupId, evidence: cloneWrite(evidence) });
    for (const listener of this.writeListeners.get(scope.childRunId) ?? []) listener(this.getChildWrites(scope.childRunId));
  }
  getWriteEvidence(filter: WriteEvidenceFilter = {}): TaskWriteEvidence[] {
    return [...this.writes.values()]
      .filter(({ groupId, evidence }) => (filter.groupId === undefined || filter.groupId === groupId) && (filter.childRunId === undefined || filter.childRunId === evidence.childRunId) && (filter.toolCallId === undefined || filter.toolCallId === evidence.toolCallId))
      .map(({ evidence }) => cloneWrite(evidence));
  }
  getChildWrites(childRunId: string): TaskWriteEvidence[] { return this.getWriteEvidence({ childRunId }); }
  onChildWrites(childRunId: string, listener: (writes: TaskWriteEvidence[]) => void): () => void {
    const listeners = this.writeListeners.get(childRunId) ?? new Set();
    listeners.add(listener); this.writeListeners.set(childRunId, listeners);
    return () => { listeners.delete(listener); if (listeners.size === 0) this.writeListeners.delete(childRunId); };
  }

  private validateScope(scope: ExecutionScope): void {
    if (scope.workspaceId !== this.workspaceId || [scope.parentRunId, scope.groupId, scope.agentId, scope.childRunId, scope.toolCallId].some(value => typeof value !== "string" || value.trim() === "")) {
      throw executionError("AGENT_EXECUTION_SCOPE_INVALID", "Leaf execution scope does not match the trusted workspace");
    }
  }
  private groupClosed(groupId: string): ToolExecutionError {
    return executionError("AGENT_EXECUTION_GROUP_CLOSED", `Execution group ${groupId} is closed`);
  }
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && !this.activeWriter) {
        const entry = this.queue[0];
        const failure = this.childFailures.get(entry.scope.childRunId);
        const closed = this.groups.get(entry.scope.groupId)?.state !== "open";
        if (entry.signal?.aborted || failure || closed) {
          this.queue.shift(); entry.removeAbortListener();
          entry.reject(failure ?? (closed ? this.groupClosed(entry.scope.groupId) : aborted()));
          continue;
        }
        if (entry.mode === "exclusive" && this.activeReaders > 0) break;
        this.queue.shift(); entry.removeAbortListener();
        const permit = Object.freeze({}) as LeafPermit;
        const operation: ActiveOperation = { permit, scope: entry.scope, mode: entry.mode, pendingLifetimes: 1, acceptingLifetimes: true };
        this.permits.set(permit, operation); this.active.add(operation);
        this.groups.get(entry.scope.groupId)!.operations.add(operation);
        if (entry.mode === "exclusive") this.activeWriter = true;
        else this.activeReaders++;
        entry.start(operation);
        // A queued writer blocks all later readers, even while earlier readers run.
        if (entry.mode === "exclusive") break;
      }
    } finally { this.pumping = false; }
  }
  private completeLifetime(operation: ActiveOperation): void {
    operation.pendingLifetimes--;
    if (operation.pendingLifetimes !== 0) return;
    this.permits.delete(operation.permit); this.active.delete(operation);
    this.groups.get(operation.scope.groupId)?.operations.delete(operation);
    if (operation.mode === "exclusive") this.activeWriter = false;
    else this.activeReaders--;
    this.pump(); this.notifyDrains();
  }
  private rejectQueued(predicate: (entry: QueuedLeaf) => boolean, error: Error): void {
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const entry = this.queue[index];
      if (!predicate(entry)) continue;
      this.queue.splice(index, 1); entry.removeAbortListener(); entry.reject(error);
    }
    this.pump(); this.notifyDrains();
  }
  private waitFor(settled: () => boolean): Promise<void> {
    if (settled()) return Promise.resolve();
    return new Promise(resolve => this.drainWaiters.add({ settled, resolve }));
  }
  private notifyDrains(): void {
    for (const waiter of this.drainWaiters) {
      if (!waiter.settled()) continue;
      this.drainWaiters.delete(waiter); waiter.resolve();
    }
  }
}

// Kept for the Main process lifetime. Never replace a coordinator while a permit,
// waiter, closing group, or path claim could still refer to it.
const workspaceCoordinators = new Map<string, RunExecutionCoordinator>();
export function getWorkspaceExecutionCoordinator(workspaceRoot: string): RunExecutionCoordinator {
  const workspaceId = canonicalWriteIdentity(workspaceRoot);
  let coordinator = workspaceCoordinators.get(workspaceId);
  if (!coordinator) {
    coordinator = new RunExecutionCoordinator(workspaceId);
    workspaceCoordinators.set(workspaceId, coordinator);
  }
  return coordinator;
}
