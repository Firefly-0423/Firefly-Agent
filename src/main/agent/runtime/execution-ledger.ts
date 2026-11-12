import type { ToolExecutionOutcome } from "./types";

export interface LogicalInvocationInput {
  args: Record<string, unknown>;
  targetRefs: string[];
  capability: string;
  logicalInvocationId: string;
}

function canonicalFacts(facts: unknown): unknown {
  if (Array.isArray(facts)) return facts.map(canonicalFacts);
  if (!facts || typeof facts !== "object") return facts;
  const pairs = Object.entries(facts as Record<string, unknown>);
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  return Object.fromEntries(pairs.map(([name, child]) => [name, canonicalFacts(child)]));
}

function requestFingerprint(input: LogicalInvocationInput): string {
  const facts = { capability: input.capability, targetRefs: input.targetRefs, args: input.args };
  return JSON.stringify(canonicalFacts(facts));
}

export class LogicalInvocationConflictError extends Error {
  readonly code = "E_LOGICAL_INVOCATION_CONFLICT"; readonly name = "LogicalInvocationConflictError";
}

export class ExecutionLedger {
  private readonly fingerprints = new Map<string, string>();
  private readonly completed = new Map<string, ToolExecutionOutcome>();

  async execute(input: LogicalInvocationInput, run: () => Promise<ToolExecutionOutcome>): Promise<{ outcome: ToolExecutionOutcome; cached: boolean }> {
    const invocationId = input.logicalInvocationId;
    const digest = requestFingerprint(input);
    const prior = this.fingerprints.get(invocationId);
    if (prior && prior !== digest) {
      throw new LogicalInvocationConflictError(`Logical invocation ${invocationId} was reused with different request facts`);
    }
    this.fingerprints.set(invocationId, digest);
    const replay = this.completed.get(invocationId);
    if (replay) return { outcome: replay, cached: true };
    const outcome = await run();
    if (outcome.status === "succeeded" && outcome.terminal !== false) this.completed.set(invocationId, outcome);
    return { outcome, cached: false };
  }
}

type ScopeRecord = { ledger: ExecutionLedger; lastUsedAt: number };

export class ExecutionLedgerStore {
  private readonly scopes = new Map<string, ScopeRecord>();
  constructor(private readonly ttlMs = 10 * 60_000, private readonly maxScopes = 256, private readonly now: () => number = Date.now) {}

  forScope(scopeId: string): ExecutionLedger {
    const timestamp = this.now();
    for (const [name, record] of this.scopes) {
      if (timestamp - record.lastUsedAt > this.ttlMs) this.scopes.delete(name);
    }
    const record = this.scopes.get(scopeId);
    if (record) {
      record.lastUsedAt = timestamp;
      return record.ledger;
    }
    if (this.scopes.size >= this.maxScopes) {
      const sorted = [...this.scopes.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
      if (sorted[0]) this.scopes.delete(sorted[0][0]);
    }
    const created = new ExecutionLedger();
    this.scopes.set(scopeId, { ledger: created, lastUsedAt: timestamp });
    return created;
  }
}
