import type { DatabaseSync } from "node:sqlite";
import type { BoundSourceRef } from "../../shared/memory-contracts";
import type { NaturalAutomationConfig, NaturalJobPhase, NaturalJobReason, NaturalRequestLimits } from "../../shared/memory-automation-contracts";
import { objectFields, parseInternalId, parseSourceRef, positiveRevision } from "../memory-core/command-validation";
import { executeTransaction, type TransactionFault } from "../memory-core/command-transactions";
import { RecordCodec } from "../memory-core/record-codec";
import { canonicalJson } from "../memory-core/repository-types";
import { SourceLedger } from "../memory-core/source-ledger";
import { Suppression } from "../memory-core/suppression";
import { transactionNow, withTransactionClock } from "../memory-core/transaction-clock";
import { NATURAL_JOB_LIMITS as limits } from "./natural-automation";
import { factDigest, validateNaturalResponse, type NaturalProposal } from "./natural-protocol";
import type {TemporalSource} from "./fact-temporal";
import type { IntegrationResult } from "./policy-contracts";

const PROTOCOL = "natural-extraction-v1", SETTINGS = "memory-settings-user-events-v1", DAY = 86400000;
const states: Record<NaturalJobPhase, string> = { unsent: "pending", "result-unknown": "running", "result-saved": "recorded", applied: "complete", blocked: "invalidated" };
const reasons: NaturalJobReason[] = ["disabled", "conflict", "source-changed", "scope-denied", "suppressed", "stale-consent", "profile-changed", "limits", "budget", "usage", "provider", "expired", "corrupt", "cancelled"];
type Profile = { id: string; revision: number };
type StoredProposal = Omit<NaturalProposal, "quote"|"time">;
type Predecessor = { candidateId: string; revision: number } | null;
interface Binding { sourceRef: BoundSourceRef; fingerprint: string; generation: number; profile: Profile; consent: NaturalAutomationConfig; predecessor: Predecessor }
interface Base { protocol: typeof PROTOCOL; actorKey: string; revision: number; updatedAt: number }
interface Job extends Base { kind: "extraction"; phase: NaturalJobPhase; binding: Binding; createdAt: number; reservation?: { token: string; day: number; units: number; limits: NaturalRequestLimits }; result?: StoredProposal[]; outcome?: IntegrationResult; reason?: NaturalJobReason }
interface Control extends Base { kind: "consent"; config: NaturalAutomationConfig; proof: BoundSourceRef }
interface Budget extends Base { kind: "budget"; day: number; requests: number; units: number; closed: boolean; nextExpiryAt: number | null }
interface ProfileRecord extends Base { kind: "profile"; profileId: string; fingerprint: string }
type RecordValue = Job | Control | Budget | ProfileRecord;
interface Hooks {
  snapshot(scope: string, actor: string, ref: BoundSourceRef): { generation?: number; predecessor?: Predecessor; done?: IntegrationResult };
  apply(scope: string, actor: string, binding: Binding, text: string, proposals: NaturalProposal[], consent: NaturalAutomationConfig): IntegrationResult;
}
export function naturalConsentStatement(revision: number, language: boolean, responseStyle: boolean): string {
  return `Natural memory consent revision ${revision}; language=${language}; responseStyle=${responseStyle}`;
}
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw Error("MEMORY_INPUT_INVALID"); return value;
};
function profile(value: unknown): Profile { const p = objectFields(value, ["id", "revision"]); return { id: parseInternalId(p.id), revision: positiveRevision(p.revision) }; }
function config(value: unknown): NaturalAutomationConfig {
  const c = objectFields(value, ["revision", "language", "responseStyle"]); if (typeof c.language !== "boolean" || typeof c.responseStyle !== "boolean") throw Error("MEMORY_INPUT_INVALID");
  return { revision: integer(c.revision), language: c.language, responseStyle: c.responseStyle };
}
function requestLimits(value: unknown): NaturalRequestLimits {
  const l = objectFields(value, ["requestBytes", "outputTokens"]), requestBytes = integer(l.requestBytes, limits.requestBytes), outputTokens = integer(l.outputTokens, limits.outputTokens);
  if (!requestBytes || !outputTokens) throw Error("MEMORY_INPUT_INVALID"); return { requestBytes, outputTokens };
}
function usage(value: unknown): { input: number; output: number; cachedInput?: number; cacheCreation?: number } | null {
  try {
    const u = objectFields(value, ["input", "output"], ["cachedInput", "cacheCreation"]), input = integer(u.input), output = integer(u.output);
    const cachedInput = u.cachedInput === undefined ? undefined : integer(u.cachedInput), cacheCreation = u.cacheCreation === undefined ? undefined : integer(u.cacheCreation);
    return { input, output, ...(cachedInput === undefined ? {} : { cachedInput }), ...(cacheCreation === undefined ? {} : { cacheCreation }) };
  } catch { return null; }
}
function proposals(value: unknown): StoredProposal[] {
  if (!Array.isArray(value) || value.length > limits.proposals) throw Error("MEMORY_DATA_INVALID");
  return value.map(p => {
    const v = objectFields(p, ["attribute", "value", "polarity", "span"]), span = objectFields(v.span, ["start", "end"]);
    if (!["address", "language", "response-style", "tool", "preference"].includes(v.attribute as string) || typeof v.value !== "string" || !v.value.trim() || v.value.length > 80 || !["positive", "negative"].includes(v.polarity as string)) throw Error("MEMORY_DATA_INVALID");
    const start = integer(span.start, limits.userChars), end = integer(span.end, limits.userChars); if (end <= start) throw Error("MEMORY_DATA_INVALID");
    return { attribute: v.attribute as NaturalProposal["attribute"], value: v.value, polarity: v.polarity as NaturalProposal["polarity"], span: { start, end } };
  });
}
function restore(text: string, saved: StoredProposal[], messageId: string, source:TemporalSource): NaturalProposal[] {
  const facts = saved.map(p => { if (p.span.end > text.length) throw Error("MEMORY_DATA_INVALID"); return { subject: "user", attribute: p.attribute === "address" ? "form-of-address" : p.attribute, value: p.value, polarity: p.polarity, quote: text.slice(p.span.start, p.span.end), status: "asserted", reason: "Validated saved user proposal" }; });
  const checked = validateNaturalResponse(JSON.stringify({ facts }), text, messageId,source);
  if (canonicalJson(checked.map(({ quote: ignored, time: ignoredTime, ...p }) => p)) !== canonicalJson(saved)) throw Error("MEMORY_DATA_INVALID"); return checked;
}

/** Namespaced encrypted jobs, independent from the legacy expiring/reclaimable lease.
 * All network work is outside this writer. Receipts contain metadata only. */
export class NaturalJobRepository {
  private readonly codec: RecordCodec; private readonly ledger: SourceLedger; private readonly suppression: Suppression;
  constructor(private readonly db: DatabaseSync, private readonly key: Uint8Array, private readonly hooks: Hooks, private readonly fault?: TransactionFault, private readonly clock: () => number = Date.now) {
    this.codec = new RecordCodec(key); this.ledger = new SourceLedger(db, key); this.suppression = new Suppression(db, key);
  }
  private prefix(actor: string): string { return "nj-" + factDigest(actor).slice(0, 20) + "-"; }
  private id(scope: string, actor: string, ref: BoundSourceRef): string { return this.prefix(actor) + factDigest({ scope, actor, ref, protocol: PROTOCOL }); }
  private controlId(actor: string): string { return "nc-" + factDigest(actor); }
  private budgetId(actor: string): string { return "nb-" + factDigest(actor); }
  private profileId(actor: string, id: string): string { return "np-" + factDigest({ actor, id }); }
  private source(scope: string, value: unknown, text?: unknown): { ref: BoundSourceRef; fingerprint: string; generation: number } {
    const ref = parseSourceRef(value); if (!ref.binding || ref.span) throw Error("MEMORY_SOURCE_INVALID");
    const head = this.ledger.assertCurrent(scope, ref), observed = head?.published;
    if (!observed || observed.role !== "user" || observed.trust !== "direct-user-event") throw Error("MEMORY_USER_SOURCE_DENIED");
    if (text !== undefined && (typeof text !== "string" || factDigest({ text, state: observed.state, role: observed.role, trust: observed.trust }) !== observed.fingerprint)) throw Error("MEMORY_SOURCE_STALE");
    const generation = this.suppression.generation(scope);
    if (head.observedSuppressionGeneration !== generation || this.suppression.sourceBlocked(scope, ref)) throw Error("MEMORY_POLICY_SUPPRESSED");
    if (observed.occurredAt !== undefined && observed.occurredAt > transactionNow(this.db)) throw Error("MEMORY_POLICY_FUTURE");
    return { ref: ref as BoundSourceRef, fingerprint: observed.fingerprint, generation };
  }
  private decode(scope: string, actor: string, id: string, row: Record<string, unknown>): RecordValue {
    try {
      const value = this.codec.open<RecordValue>("jobs", scope, id, row.payload);
      objectFields(value, ["protocol", "kind", "actorKey", "revision", "updatedAt"], ["phase", "binding", "createdAt", "reservation", "result", "outcome", "reason", "config", "proof", "day", "requests", "units", "closed", "nextExpiryAt", "profileId", "fingerprint"]);
      if (value.protocol !== PROTOCOL || value.actorKey !== actor || value.revision !== positiveRevision(row.revision)) throw Error("MEMORY_DATA_INVALID"); integer(value.updatedAt);
      if (value.kind === "consent") {
        objectFields(value, ["protocol", "kind", "actorKey", "revision", "updatedAt", "config", "proof"]); config(value.config);
        const ref = parseSourceRef(value.proof); if (id !== this.controlId(actor) || row.state !== "complete" || !ref.binding || ref.binding.sessionId !== SETTINGS || row.source_id !== ref.sourceId || value.config.revision !== value.revision) throw Error("MEMORY_DATA_INVALID");
      } else if (value.kind === "budget") {
        objectFields(value, ["protocol", "kind", "actorKey", "revision", "updatedAt", "day", "requests", "units", "closed", "nextExpiryAt"]); integer(value.day); integer(value.requests, limits.requestsPerDay); integer(value.units, limits.reservedUnitsPerDay); if (value.nextExpiryAt !== null) integer(value.nextExpiryAt);
        if (id !== this.budgetId(actor) || row.state !== "complete" || row.source_id !== null || typeof value.closed !== "boolean" || value.day !== Math.floor(value.updatedAt / DAY)) throw Error("MEMORY_DATA_INVALID");
      } else if (value.kind === "profile") {
        objectFields(value, ["protocol", "kind", "actorKey", "revision", "updatedAt", "profileId", "fingerprint"]); parseInternalId(value.profileId);
        if (id !== this.profileId(actor, value.profileId) || row.state !== "complete" || row.source_id !== null || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw Error("MEMORY_DATA_INVALID");
      } else if (value.kind === "extraction") {
        objectFields(value, ["protocol", "kind", "actorKey", "revision", "updatedAt", "phase", "binding", "createdAt"], ["reservation", "result", "outcome", "reason"]);
        integer(value.createdAt); if (value.updatedAt < value.createdAt || !Object.hasOwn(states, value.phase) || row.state !== states[value.phase]) throw Error("MEMORY_DATA_INVALID");
        const b = objectFields(value.binding, ["sourceRef", "fingerprint", "generation", "profile", "consent", "predecessor"]), ref = parseSourceRef(b.sourceRef);
        if (!ref.binding || ref.span || row.source_id !== ref.sourceId || id !== this.id(scope, actor, ref as BoundSourceRef) || typeof b.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(b.fingerprint)) throw Error("MEMORY_DATA_INVALID");
        integer(b.generation); profile(b.profile); config(b.consent);
        if (b.predecessor !== null) { const p = objectFields(b.predecessor, ["candidateId", "revision"]); parseInternalId(p.candidateId); positiveRevision(p.revision); }
        if (value.reservation !== undefined) { const r = objectFields(value.reservation, ["token", "day", "units", "limits"]); parseInternalId(r.token); integer(r.day); requestLimits(r.limits); if (r.units !== value.reservation.limits.requestBytes + 1024 + value.reservation.limits.outputTokens) throw Error("MEMORY_DATA_INVALID"); }
        if (["result-unknown", "result-saved", "applied"].includes(value.phase) && !value.reservation) throw Error("MEMORY_DATA_INVALID");
        if (value.result !== undefined) proposals(value.result);
        if ((value.phase === "result-saved") !== (value.result !== undefined) || (value.phase === "applied") !== (value.outcome !== undefined)) throw Error("MEMORY_DATA_INVALID");
        if (value.outcome !== undefined) {
          const o = objectFields(value.outcome, ["items"]); if (!Array.isArray(o.items) || o.items.length > limits.proposals) throw Error("MEMORY_DATA_INVALID");
          for (const item of o.items) { const i = objectFields(item, ["status"], ["candidateId", "candidateRevision", "factId", "factRevision", "reason"]); if (!["candidate", "active", "rejected", "suppressed", "forgotten", "pending-review"].includes(i.status as string)) throw Error("MEMORY_DATA_INVALID"); for (const k of ["candidateId", "factId", "reason"]) if (i[k] !== undefined) parseInternalId(i[k]); for (const k of ["candidateRevision", "factRevision"]) if (i[k] !== undefined) positiveRevision(i[k]); }
        }
        if (value.reason !== undefined && !reasons.includes(value.reason)) throw Error("MEMORY_DATA_INVALID");
      } else throw Error("MEMORY_DATA_INVALID");
      return value;
    } catch { throw Error("MEMORY_DATA_INVALID"); }
  }
  private record(scope: string, actor: string, id: string): RecordValue | undefined {
    const row = this.db.prepare("SELECT revision,state,source_id,payload FROM jobs WHERE id=? AND scope_key=?").get(id, scope); return row ? this.decode(scope, actor, id, row) : undefined;
  }
  private jobs(scope: string, actor: string): Array<{ id: string; job: Job }> {
    const rows = this.db.prepare("SELECT id,revision,state,source_id,payload FROM jobs WHERE scope_key=? AND id LIKE ? ORDER BY id LIMIT ?").all(scope, this.prefix(actor) + "%", limits.rowsPerActor + 1);
    if (rows.length > limits.rowsPerActor) throw Error("MEMORY_DATA_INVALID");
    return rows.map(row => {
      const id = row.id as string, value = this.decode(scope, actor, id, row); if (value.kind !== "extraction") throw Error("MEMORY_DATA_INVALID"); return { id, job: value };
    });
  }
  private control(scope: string, actor: string): NaturalAutomationConfig {
    const value = this.record(scope, actor, this.controlId(actor)); if (!value) return { revision: 0, language: false, responseStyle: false }; if (value.kind !== "consent") throw Error("MEMORY_DATA_INVALID"); return value.config;
  }
  private budget(scope: string, actor: string): Budget {
    const now = transactionNow(this.db), value = this.record(scope, actor, this.budgetId(actor));
    if (!value && this.counts(scope, actor).total !== 0) throw Error("MEMORY_DATA_INVALID");
    if (value && (value.kind !== "budget" || value.updatedAt > now)) throw Error("MEMORY_NATURAL_CLOCK_INVALID");
    if (value && value.kind === "budget" && value.day === Math.floor(now / DAY)) return value;
    return { protocol: PROTOCOL, kind: "budget", actorKey: actor, revision: value?.revision ?? 0, updatedAt: now, day: Math.floor(now / DAY), requests: 0, units: 0, closed: false, nextExpiryAt: value?.nextExpiryAt ?? null };
  }
  private counts(scope: string, actor: string): { total: number; pending: number } {
    const row = this.db.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN state IN ('pending','running','recorded') THEN 1 ELSE 0 END),0) AS pending FROM jobs WHERE scope_key=? AND id LIKE ?").get(scope, this.prefix(actor) + "%")!;
    return { total: row.total as number, pending: row.pending as number };
  }
  private put(scope: string, id: string, value: RecordValue, sourceId: string | null): void {
    const now = transactionNow(this.db); if (now < value.updatedAt) throw Error("MEMORY_NATURAL_CLOCK_INVALID"); value.revision++; value.updatedAt = now;
    this.db.prepare("INSERT INTO jobs(id,scope_key,revision,source_id,parent_id,state,payload) VALUES(?,?,?,?,NULL,?,?) ON CONFLICT(id,scope_key) DO UPDATE SET revision=excluded.revision,source_id=excluded.source_id,state=excluded.state,payload=excluded.payload")
      .run(id, scope, value.revision, sourceId, value.kind === "extraction" ? states[value.phase] : "complete", this.codec.seal("jobs", scope, id, value)); this.fault?.("after-record");
  }
  private view(id: string, job: Job): object { return { id, revision: job.revision, phase: job.phase, sourceRef: job.binding.sourceRef, profile: job.binding.profile, createdAt: job.createdAt, updatedAt: job.updatedAt, ...(job.reason ? { reason: job.reason } : {}), ...(job.outcome ? { outcome: job.outcome } : {}) }; }
  private job(scope: string, actor: string, id: string): Job { const job = this.record(scope, actor, id); if (!job) throw Error("MEMORY_NATURAL_JOB_NOT_FOUND"); if (job.kind !== "extraction") throw Error("MEMORY_DATA_INVALID"); return job; }
  private blocked(scope: string, id: string, job: Job, reason: NaturalJobReason): object { job.phase = "blocked"; job.reason = reason; delete job.result; delete job.outcome; this.put(scope, id, job, job.binding.sourceRef.sourceId); return this.view(id, job); }
  private recheck(scope: string, job: Job, currentProfile: Profile, text?: unknown): NaturalJobReason | null {
    if (transactionNow(this.db) - job.createdAt > limits.retentionMs) return "expired";
    if (canonicalJson(currentProfile) !== canonicalJson(job.binding.profile)) return "profile-changed";
    if (this.suppression.generation(scope) !== job.binding.generation) return "suppressed";
    try { if (this.source(scope, job.binding.sourceRef, text).fingerprint !== job.binding.fingerprint) return "source-changed"; }
    catch (e) { if (e instanceof Error && ["MEMORY_SOURCE_INVALID", "MEMORY_SOURCE_STALE", "MEMORY_SOURCE_PENDING", "MEMORY_SOURCE_DELETED", "MEMORY_USER_SOURCE_DENIED", "MEMORY_POLICY_SUPPRESSED"].includes(e.message)) return e.message === "MEMORY_POLICY_SUPPRESSED" ? "suppressed" : "source-changed"; throw e; }
    return null;
  }
  private state(scope: string, actor: string): object {
    const budget = this.budget(scope, actor), counts: Record<NaturalJobPhase, number> = { unsent: 0, "result-unknown": 0, "result-saved": 0, applied: 0, blocked: 0 };
    for (const { job } of this.jobs(scope, actor)) if (transactionNow(this.db) - job.createdAt <= limits.retentionMs) counts[job.phase]++;
    return { config: this.control(scope, actor), budget: { day: budget.day, requests: budget.requests, units: budget.units, closed: budget.closed }, counts };
  }
  execute(value: unknown): unknown {
    const cmd = objectFields(value, ["kind", "scopeKey", "body"], ["commandId"]), scope = parseInternalId(cmd.scopeKey), base = objectFields(cmd.body, ["actorKey", "operation"], ["expectedRevision", "language", "responseStyle", "sourceRef", "sourceText", "profile", "jobId", "token", "limits", "result", "reason", "profileId", "definition"]), actor = parseInternalId(base.actorKey), operation = base.operation;
    if (cmd.kind !== "naturalJob" || typeof operation !== "string") throw Error("MEMORY_INPUT_INVALID");
    const fields: Record<string, string[]> = { state: [], profile: ["profileId", "definition"], configure: ["expectedRevision", "language", "responseStyle", "sourceRef", "sourceText"], enqueue: ["sourceRef", "sourceText", "profile"], dispatch: ["jobId", "profile", "token", "limits"], save: ["jobId", "profile", "token", "sourceText", "result"], block: ["jobId", "reason"], get: ["jobId"], lookup: ["sourceRef"], list: [], apply: ["jobId", "profile", "sourceText"] };
    if (!Object.hasOwn(fields, operation)) throw Error("MEMORY_INPUT_INVALID"); const body = objectFields(cmd.body, ["actorKey", "operation", ...fields[operation]]);
    if (["state", "get", "list", "lookup"].includes(operation)) {
      this.db.exec("BEGIN"); try { return withTransactionClock(this.db, this.clock, () => {
        let result: unknown;
        if (operation === "state") result = this.state(scope, actor);
        else if (operation === "get") { const id = parseInternalId(body.jobId); result = this.view(id, this.job(scope, actor, id)); }
        else if (operation === "lookup") { const ref = parseSourceRef(body.sourceRef); if (!ref.binding || ref.span) throw Error("MEMORY_SOURCE_INVALID"); const id = this.id(scope, actor, ref as BoundSourceRef), job = this.record(scope, actor, id); if (job && job.kind !== "extraction") throw Error("MEMORY_DATA_INVALID"); result = job ? this.view(id, job as Job) : null; }
        else result = { jobs: this.jobs(scope, actor).filter(({ job }) => !["applied", "blocked"].includes(job.phase) && transactionNow(this.db) - job.createdAt <= limits.retentionMs).map(({ id, job }) => this.view(id, job)) };
        this.db.exec("COMMIT"); return result;
      }); } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    }
    parseInternalId(cmd.commandId);
    const ref = operation === "enqueue" ? parseSourceRef(body.sourceRef) : undefined;
    // Once-per-source intent survives retention; caller profile/consent changes cannot re-enqueue it.
    const commandId = ref ? "natural-enqueue-" + factDigest({ scope, actor, ref, protocol: PROTOCOL }) : cmd.commandId as string;
    let result: Record<string, unknown> | undefined;
    if (operation === "save") {
      const r = objectFields(body.result, ["ok"], ["text", "usage", "kind"]);
      if (r.ok === true) { objectFields(r, ["ok", "text"], ["usage"]); if (typeof r.text !== "string") throw Error("MEMORY_INPUT_INVALID"); result = { ok: true, text: r.text, usage: usage(r.usage) }; }
      else { objectFields(r, ["ok", "kind"]); if (r.ok !== false || !["quota", "rate-limit", "timeout", "network", "http", "cancelled", "limits"].includes(r.kind as string)) throw Error("MEMORY_INPUT_INVALID"); result = r; }
    }
    const request = ref ? { operation, scope, actor, ref } : result ? { ...cmd, body: { ...body, result: { ...result, ...(typeof result.text === "string" ? { text: factDigest(result.text) } : {}) } } } : value;
    return executeTransaction({ db: this.db, key: this.key, scope, commandId, request, fault: this.fault, clock: this.clock, apply: () => {
      const now = transactionNow(this.db);
      if (operation === "profile") {
        const profileId = parseInternalId(body.profileId), definition = objectFields(body.definition, ["provider", "baseUrl", "model", "apiKey", "window"], ["explicitTransport", "reasoning", "timeout"]);
        for (const name of ["provider", "baseUrl", "model", "apiKey"]) if (typeof definition[name] !== "string") throw Error("MEMORY_INPUT_INVALID");
        positiveRevision(definition.window); if (definition.timeout !== undefined) integer(definition.timeout);
        const bytes = Buffer.from(canonicalJson({ scope, actor, profileId, definition })); let fingerprint: string;
        try { if (bytes.length > limits.requestBytes) throw Error("MEMORY_INPUT_INVALID"); fingerprint = createHmac("sha256", this.key).update("FireflyNaturalProfile-v1").update(bytes).digest("hex"); } finally { bytes.fill(0); }
        const id = this.profileId(actor, profileId), previous = this.record(scope, actor, id);
        if (previous && previous.kind !== "profile") throw Error("MEMORY_DATA_INVALID");
        if (previous?.kind === "profile" && previous.fingerprint === fingerprint) return { id: profileId, revision: previous.revision };
        const record: ProfileRecord = { protocol: PROTOCOL, kind: "profile", actorKey: actor, revision: previous?.revision ?? 0, updatedAt: now, profileId, fingerprint };
        this.put(scope, id, record, null); return { id: profileId, revision: record.revision };
      }
      if (operation === "configure") {
        const current = this.control(scope, actor), expected = integer(body.expectedRevision); if (expected !== current.revision) throw Error("MEMORY_REVISION_CONFLICT");
        if (typeof body.language !== "boolean" || typeof body.responseStyle !== "boolean") throw Error("MEMORY_INPUT_INVALID");
        const checked = this.source(scope, body.sourceRef, body.sourceText);
        if (checked.ref.binding.sessionId !== SETTINGS || body.sourceText !== naturalConsentStatement(expected, body.language, body.responseStyle)) throw Error("MEMORY_NATURAL_CONSENT_DENIED");
        this.put(scope, this.controlId(actor), { protocol: PROTOCOL, kind: "consent", actorKey: actor, revision: current.revision, config: { revision: current.revision + 1, language: body.language, responseStyle: body.responseStyle }, proof: checked.ref, updatedAt: now }, checked.ref.sourceId); return this.state(scope, actor);
      }
      if (operation === "enqueue") {
        if (typeof body.sourceText !== "string" || !body.sourceText.trim() || body.sourceText.length > limits.userChars) throw Error("MEMORY_INPUT_INVALID");
        const checked = this.source(scope, ref, body.sourceText), p = profile(body.profile), id = this.id(scope, actor, checked.ref);
        if (checked.ref.binding.sessionId === SETTINGS) throw Error("MEMORY_USER_SOURCE_DENIED");
        // An existing journal is authoritative even if its enqueue receipt was damaged.
        // Never overwrite a sent/saved phase with a new unsent record.
        const existing = this.record(scope, actor, id);
        if (existing) { if (existing.kind !== "extraction") throw Error("MEMORY_DATA_INVALID"); return this.view(id, existing); }
        const snapshot = this.hooks.snapshot(scope, actor, checked.ref); if (snapshot.done) return { id: null, outcome: snapshot.done };
        const budget = this.budget(scope, actor);
        if (budget.nextExpiryAt !== null && budget.nextExpiryAt < now) {
          budget.nextExpiryAt = null;
          for (const old of this.jobs(scope, actor)) {
            if (now - old.job.createdAt > limits.retentionMs) this.db.prepare("DELETE FROM jobs WHERE id=? AND scope_key=?").run(old.id, scope);
            else budget.nextExpiryAt = Math.min(budget.nextExpiryAt ?? Number.MAX_SAFE_INTEGER, old.job.createdAt + limits.retentionMs);
          }
        }
        const counts = this.counts(scope, actor); if (counts.total >= limits.rowsPerActor || counts.pending >= limits.nonterminalJobs) throw Error("MEMORY_NATURAL_QUEUE_FULL");
        const expiry = now + limits.retentionMs; if (!Number.isSafeInteger(expiry)) throw Error("MEMORY_NATURAL_CLOCK_INVALID");
        budget.nextExpiryAt = Math.min(budget.nextExpiryAt ?? expiry, expiry); this.put(scope, this.budgetId(actor), budget, null);
        const job: Job = { protocol: PROTOCOL, kind: "extraction", actorKey: actor, revision: 0, createdAt: now, updatedAt: now, phase: "unsent", binding: { sourceRef: checked.ref, fingerprint: checked.fingerprint, generation: checked.generation, profile: p, consent: this.control(scope, actor), predecessor: snapshot.predecessor ?? null } };
        this.put(scope, id, job, checked.ref.sourceId); return this.view(id, job);
      }
      const id = parseInternalId(body.jobId), job = this.job(scope, actor, id);
      if (operation === "block") { if (!reasons.includes(body.reason as NaturalJobReason)) throw Error("MEMORY_INPUT_INVALID"); return job.phase === "applied" || job.phase === "blocked" ? this.view(id, job) : this.blocked(scope, id, job, body.reason as NaturalJobReason); }
      if (operation === "apply" && job.phase === "applied") return this.view(id, job);
      if (job.phase !== (operation === "dispatch" ? "unsent" : operation === "save" ? "result-unknown" : "result-saved")) throw Error("MEMORY_NATURAL_JOB_STATE");
      const currentProfile = profile(body.profile), changed = this.recheck(scope, job, currentProfile, operation === "dispatch" ? undefined : body.sourceText); if (changed) return this.blocked(scope, id, job, changed);
      if (operation === "dispatch") {
        const requested = requestLimits(body.limits), token = parseInternalId(body.token), budget = this.budget(scope, actor), units = requested.requestBytes + 1024 + requested.outputTokens;
        if (budget.closed || budget.requests >= limits.requestsPerDay || budget.units + units > limits.reservedUnitsPerDay) return this.blocked(scope, id, job, "budget");
        budget.requests++; budget.units += units; this.put(scope, this.budgetId(actor), budget, null);
        job.phase = "result-unknown"; job.reservation = { token, day: budget.day, units, limits: requested }; this.put(scope, id, job, job.binding.sourceRef.sourceId); return this.view(id, job);
      }
      if (operation === "save") {
        if (parseInternalId(body.token) !== job.reservation!.token) throw Error("MEMORY_NATURAL_JOB_STATE");
        const closeDay = () => { const budget = this.budget(scope, actor); budget.closed = true; this.put(scope, this.budgetId(actor), budget, null); };
        if (result!.ok === false) {
          if (["quota", "rate-limit"].includes(result!.kind as string)) closeDay();
          if (["timeout", "network", "cancelled"].includes(result!.kind as string)) { job.reason = result!.kind === "cancelled" ? "cancelled" : "provider"; this.put(scope, id, job, job.binding.sourceRef.sourceId); return this.view(id, job); }
          return this.blocked(scope, id, job, result!.kind === "limits" ? "limits" : "provider");
        }
        const u = result!.usage as ReturnType<typeof usage>;
        if (!u || u.output > job.reservation!.limits.outputTokens || u.input + u.output + (u.cachedInput ?? 0) + (u.cacheCreation ?? 0) > job.reservation!.units) { closeDay(); return this.blocked(scope, id, job, "usage"); }
        const text = result!.text as string; if (Buffer.byteLength(text) > limits.resultBytes) return this.blocked(scope, id, job, "limits");
        try { const parsed = JSON.parse(text); if (Array.isArray(parsed?.facts) && parsed.facts.length > limits.proposals) return this.blocked(scope, id, job, "limits"); } catch { /* Schema validation below admits no malformed proposal. */ }
        job.result = validateNaturalResponse(text, body.sourceText as string, job.binding.sourceRef.binding.messageId,this.ledger.assertCurrent(scope,job.binding.sourceRef)!.published!).map(({ quote: ignored, time: ignoredTime, ...p }) => p); job.phase = "result-saved"; delete job.reason;
        this.put(scope, id, job, job.binding.sourceRef.sourceId); return this.view(id, job);
      }
      const text = body.sourceText as string, checked = restore(text, job.result!, job.binding.sourceRef.binding.messageId,this.ledger.assertCurrent(scope,job.binding.sourceRef)!.published!);
      job.outcome = this.hooks.apply(scope, actor, job.binding, text, checked, this.control(scope, actor)); job.phase = "applied"; delete job.result; delete job.reason;
      this.put(scope, id, job, job.binding.sourceRef.sourceId); return this.view(id, job);
    } });
  }
}
import { createHmac } from "node:crypto";
