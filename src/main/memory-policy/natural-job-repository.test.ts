import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { MemoryRepository } from "../memory-core/repository";
import { initializeSchema } from "../memory-core/schema";
import { canonicalJson } from "../memory-core/repository-types";
import { RecordCodec } from "../memory-core/record-codec";
import { createMainSourceProvider, type SourceSnapshot } from "../memory-sources/main-source-provider";
import { createMainSourceRegistry } from "../memory-sources/source-registry";
import type { BoundSourceRef } from "../../shared/memory-contracts";

const SETTINGS = "memory-settings-user-events-v1", profile = { id: "synthetic", revision: 1 };
const owned: Array<() => void> = [];
afterEach(() => { for (const close of owned.splice(0).reverse()) close(); });
function fixture(input: { file?: string; key?: Buffer; entries?: Map<string, SourceSnapshot>; time?: { now: number } } = {}) {
  const db = new DatabaseSync(input.file ?? ":memory:"), key = Buffer.from(input.key ?? randomBytes(32)), entries = input.entries ?? new Map<string, SourceSnapshot>(), time = input.time ?? { now: 1700000000000 };
  initializeSchema(db, "natural-journal-fixture"); let fail: string | undefined;
  const repo = new MemoryRepository(db, Buffer.from(key), input.file ?? ":memory:", "natural-journal-fixture", stage => { if (stage === fail) throw Error("SYNTHETIC_FAULT"); }, () => time.now);
  const registry = createMainSourceRegistry({ sourceCommand: async c => repo.sourceCommand(c) }), access = registry.authority.access("scope-a");
  const adapter = createMainSourceProvider({ providerId: "synthetic", authorize: (scope, id) => scope === "scope-a" && ["session-a", SETTINGS].includes(id.sessionId), withLease: async (id, run) => run(async () => structuredClone(entries.get(canonicalJson(id))!)) });
  let closed = false; const close = () => { if (!closed) { closed = true; repo.close(); key.fill(0); } }; owned.push(close);
  const op = (operation: string, body: Record<string, unknown> = {}, commandId = randomUUID(), actorKey = "actor-a"): any => repo.policyCommand({ kind: "naturalJob", scopeKey: "scope-a", commandId, body: { actorKey, operation, ...body } });
  async function source(text: string, sessionId = "session-a", patch: Partial<SourceSnapshot> = {}) {
    const id = { providerId: "synthetic", sessionId, messageId: randomUUID() };
    entries.set(canonicalJson(id), { ...id, generation: randomUUID(), contentRevision: 1, state: "live", role: "user", trust: "direct-user-event", text, ...patch });
    return { id, ref: await registry.capture(access, adapter, id), text };
  }
  async function consent(language = true, responseStyle = false, revision = 0) {
    const s = await source(`Natural memory consent revision ${revision}; language=${language}; responseStyle=${responseStyle}`, SETTINGS);
    return op("configure", { expectedRevision: revision, language, responseStyle, sourceRef: s.ref, sourceText: s.text });
  }
  return { db, key, entries, time, repo, op, source, consent, registry, access, adapter, close, fault: (stage?: string) => { fail = stage; } };
}
const text = "I always prefer English for our chats";
const raw = (quote = text) => JSON.stringify({ facts: [{ subject: "user", attribute: "language", value: "English", polarity: "positive", status: "asserted", quote, reason: "direct self statement" }] });
async function queued(f: ReturnType<typeof fixture>, content = text) { const s = await f.source(content); return { ...s, job: f.op("enqueue", { sourceRef: s.ref, sourceText: s.text, profile }) }; }
function dispatch(f: ReturnType<typeof fixture>, q: Awaited<ReturnType<typeof queued>>, limits = { requestBytes: 1000, outputTokens: 800 }) {
  const token = randomUUID(), result = f.op("dispatch", { jobId: q.job.id, profile, token, limits }); return { token, result };
}
function save(f: ReturnType<typeof fixture>, q: Awaited<ReturnType<typeof queued>>, token: string, result: unknown = { ok: true, text: raw(q.text), usage: { input: 100, output: 20 } }, commandId?: string) {
  return f.op("save", { jobId: q.job.id, profile, token, sourceText: q.text, result }, commandId);
}

it("reads default-off controls without creating a job, then changes consent only from an exact settings source and CAS", async () => {
  const f = fixture(); expect(f.op("state")).toMatchObject({ config: { revision: 0, language: false, responseStyle: false }, budget: { requests: 0, units: 0, closed: false } }); expect(f.repo.readRows("jobs", "scope-a")).toEqual([]);
  const sourceText = "Natural memory consent revision 0; language=true; responseStyle=false", chat = await f.source(sourceText);
  expect(() => f.op("configure", { expectedRevision: 0, language: true, responseStyle: false, sourceRef: chat.ref, sourceText })).toThrow("MEMORY_NATURAL_CONSENT_DENIED");
  expect(await f.consent()).toMatchObject({ config: { revision: 1, language: true, responseStyle: false } });
  await expect(f.consent(false, true, 0)).rejects.toThrow("MEMORY_REVISION_CONFLICT");
  expect(f.op("state", {}, randomUUID(), "actor-b").config).toEqual({ revision: 0, language: false, responseStyle: false });
});

it.each([{ role: "assistant" }, { trust: "history" }, { occurredAt: 1700000000001 }])("rejects non-authoritative or future source before persistent extraction: %j", async patch => {
  const f = fixture(), s = await f.source(text, "session-a", patch as Partial<SourceSnapshot>);
  expect(() => f.op("enqueue", { sourceRef: s.ref, sourceText: text, profile })).toThrow(); expect(f.repo.readRows("jobs", "scope-a")).toEqual([]);
});

it("rejects forged source text, unbound refs, extra authorization fields and oversized source before enqueue", async () => {
  const f = fixture(), s = await f.source(text);
  for (const body of [{ sourceRef: s.ref, sourceText: text + " forged", profile }, { sourceRef: { sourceId: s.ref.sourceId, revision: s.ref.revision }, sourceText: text, profile }, { sourceRef: s.ref, sourceText: text, profile, autoAdd: true }]) expect(() => f.op("enqueue", body)).toThrow();
  const long = await f.source("x".repeat(4001)); expect(() => f.op("enqueue", { sourceRef: long.ref, sourceText: long.text, profile })).toThrow(); expect(f.repo.readRows("jobs", "scope-a")).toEqual([]);
});

it("captures one source/consent/profile binding, saves only normalized fields, applies locally once and denies the legacy lease API", async () => {
  const f = fixture(); await f.consent(false, false); const q = await queued(f), again = f.op("enqueue", { sourceRef: q.ref, sourceText: q.text, profile: { id: "other-profile", revision: 2 } });
  expect(again.id).toBe(q.job.id); expect(q.job).toMatchObject({ phase: "unsent", profile });
  expect(() => f.repo.jobCommand({ kind: "claim", scopeKey: "scope-a", commandId: randomUUID(), body: { jobId: q.job.id, leaseMs: 100 } })).toThrow("MEMORY_DATA_INVALID");
  const d = dispatch(f, q); expect(d.result.phase).toBe("result-unknown"); expect(f.op("state").budget).toMatchObject({ requests: 1, units: 2824 });
  expect(() => dispatch(f, q)).toThrow("MEMORY_NATURAL_JOB_STATE");
  expect(save(f, q, d.token)).toMatchObject({ phase: "result-saved" });
  const stored = f.repo.readRows("jobs", "scope-a").find(row => row.id === q.job.id)!.payload as any;
  expect(stored).toMatchObject({ protocol: "natural-extraction-v1", phase: "result-saved", binding: { consent: { revision: 1, language: false, responseStyle: false }, profile } });
  expect(stored.result).toEqual([{ attribute: "language", value: "English", polarity: "positive", span: { start: 0, end: q.text.length } }]);
  expect(JSON.stringify(stored)).not.toContain(q.text); expect(JSON.stringify(stored)).not.toMatch(/direct self statement|"quote"/);
  const applied = f.op("apply", { jobId: q.job.id, profile, sourceText: q.text }); expect(applied).toMatchObject({ phase: "applied", outcome: { items: [{ status: "candidate" }] } });
  expect(f.op("apply", { jobId: q.job.id, profile, sourceText: q.text })).toEqual(applied);
  expect(f.repo.readRows("candidates", "scope-a")).toHaveLength(1); expect(f.repo.current("scope-a")).toEqual([]);
  const payloads = f.repo.readRows("jobs", "scope-a").map(row => row.payload); expect(JSON.stringify(payloads)).not.toContain(q.text);
});

it.each(["unsent", "result-unknown", "result-saved", "applied"] as const)("reopens durable %s phase without an expiring network lease", async phase => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "natural-reopen-")); owned.push(() => fs.rmSync(root, { recursive: true, force: true }));
  let f = fixture({ file: path.join(root, "memory.sqlite") }); const q = await queued(f);
  if (phase !== "unsent") { const d = dispatch(f, q); if (phase !== "result-unknown") { save(f, q, d.token); if (phase === "applied") f.op("apply", { jobId: q.job.id, profile, sourceText: q.text }); } }
  const key = Buffer.from(f.key), entries = f.entries, time = f.time; f.close(); f = fixture({ file: path.join(root, "memory.sqlite"), key, entries, time }); key.fill(0);
  expect(f.op("get", { jobId: q.job.id }).phase).toBe(phase);
  if (phase === "result-unknown") { f.time.now += 60001; expect(() => dispatch(f, q)).toThrow("MEMORY_NATURAL_JOB_STATE"); expect(f.op("state").budget.requests).toBe(1); }
  if (phase === "result-saved") { expect(f.op("apply", { jobId: q.job.id, profile, sourceText: q.text }).phase).toBe("applied"); expect(f.op("state").budget.requests).toBe(1); }
});

it.each([{ input: -1, output: 20 }, { input: 1.5, output: 20 }, { input: NaN, output: 20 }, { input: Infinity, output: 20 }, { input: Number.MAX_SAFE_INTEGER, output: 1 }, { input: 100, output: 801 }, { input: 100000, output: 20 }, { input: 100, output: 20, cachedInput: -1 }, undefined])("corrupt, missing or excessive usage closes the day and never persists a result: %j", async usage => {
  const f = fixture(), q = await queued(f), d = dispatch(f, q), result = save(f, q, d.token, { ok: true, text: raw(), ...(usage ? { usage } : {}) });
  expect(result).toMatchObject({ phase: "blocked", reason: "usage" }); expect(f.op("state").budget).toMatchObject({ requests: 1, closed: true });
  const next = await queued(f); expect(dispatch(f, next).result).toMatchObject({ phase: "blocked", reason: "budget" }); expect(f.repo.readRows("candidates", "scope-a")).toEqual([]);
});

it.each(["quota", "rate-limit"])("closes the day on %s without refunding a reservation", async kind => {
  const f = fixture(), q = await queued(f), d = dispatch(f, q); expect(save(f, q, d.token, { ok: false, kind })).toMatchObject({ phase: "blocked", reason: "provider" }); expect(f.op("state").budget).toMatchObject({ requests: 1, units: 2824, closed: true });
});
it.each(["timeout", "network", "cancelled"])("keeps ambiguous %s result unknown and never reclaims it", async kind => {
  const f = fixture(), q = await queued(f), d = dispatch(f, q); expect(save(f, q, d.token, { ok: false, kind }).phase).toBe("result-unknown"); f.time.now += 60001; expect(() => dispatch(f, q)).toThrow("MEMORY_NATURAL_JOB_STATE"); expect(f.op("state").budget.requests).toBe(1);
});

it.each([{ requestBytes: 16385, outputTokens: 800 }, { requestBytes: 1000, outputTokens: 801 }, { requestBytes: 0, outputTokens: 800 }, { requestBytes: 1, outputTokens: NaN }])("rejects unproved request bounds before reserving: %j", async limits => {
  const f = fixture(), q = await queued(f); expect(() => dispatch(f, q, limits)).toThrow(); expect(f.op("state").budget.requests).toBe(0); expect(f.op("get", { jobId: q.job.id }).phase).toBe("unsent");
});

it("enforces20 daily requests, UTC reset, budget reservation and clock rollback without refund", async () => {
  const f = fixture(); for (let i = 0; i < 20; i++) expect(dispatch(f, await queued(f)).result.phase).toBe("result-unknown");
  expect(dispatch(f, await queued(f)).result).toMatchObject({ phase: "blocked", reason: "budget" }); expect(f.op("state").budget.requests).toBe(20);
  f.time.now += 86400000; const next = await queued(f); expect(dispatch(f, next).result.phase).toBe("result-unknown"); expect(f.op("state").budget.requests).toBe(1);
  const rollback = await queued(f); f.time.now -= 86400000; expect(() => dispatch(f, rollback)).toThrow("MEMORY_NATURAL_CLOCK_INVALID");
  const b = fixture(); for (let i = 0; i < 5; i++) dispatch(b, await queued(b), { requestBytes: 16000, outputTokens: 800 });
  expect(dispatch(b, await queued(b), { requestBytes: 16000, outputTokens: 800 }).result).toMatchObject({ phase: "blocked", reason: "budget" }); expect(b.op("state").budget.units).toBe(89120);
});

it("enforces backlog100 and total1000, then prunes after7days without allowing expired input to enqueue again", async () => {
  const f = fixture(); let first: Awaited<ReturnType<typeof queued>> | undefined;
  for (let i = 0; i < 100; i++) { const q = await queued(f); first ??= q; }
  await expect(queued(f)).rejects.toThrow("MEMORY_NATURAL_QUEUE_FULL");
  for (const q of f.op("list").jobs) f.op("block", { jobId: q.id, reason: "cancelled" });
  for (let i = 100; i < 1000; i++) { const q = await queued(f); f.op("block", { jobId: q.job.id, reason: "cancelled" }); }
  await expect(queued(f)).rejects.toThrow("MEMORY_NATURAL_QUEUE_FULL"); f.time.now += 7 * 86400000 + 1; const fresh = await queued(f);
  expect(f.repo.readRows("jobs", "scope-a").filter(row => (row.payload as any).kind === "extraction")).toHaveLength(1);
  expect(f.op("enqueue", { sourceRef: first!.ref, sourceText: first!.text, profile }).id).toBe(first!.job.id); expect(() => f.op("get", { jobId: first!.job.id })).toThrow("MEMORY_NATURAL_JOB_NOT_FOUND"); expect(f.op("get", { jobId: fresh.job.id }).phase).toBe("unsent");
});

it("save/apply faults roll back the journal and Core candidate atomically; bad ciphertext never becomes a default", async () => {
  const f = fixture(), q = await queued(f), d = dispatch(f, q); f.fault("before-receipt"); expect(() => save(f, q, d.token)).toThrow("SYNTHETIC_FAULT"); f.fault(); expect(f.op("get", { jobId: q.job.id }).phase).toBe("result-unknown"); save(f, q, d.token);
  f.fault("after-record"); expect(() => f.op("apply", { jobId: q.job.id, profile, sourceText: q.text })).toThrow("SYNTHETIC_FAULT"); f.fault(); expect(f.op("get", { jobId: q.job.id }).phase).toBe("result-saved"); expect(f.repo.readRows("candidates", "scope-a")).toEqual([]);
  f.db.prepare("UPDATE jobs SET payload=? WHERE id=?").run(Buffer.from("corrupt"), q.job.id); expect(() => f.op("get", { jobId: q.job.id })).toThrow(); expect(() => f.op("state")).toThrow();
});

it("denies actor/profile/source changes, bad normalized saved spans and result size without reviving a job", async () => {
  const f = fixture(), q = await queued(f); expect(() => f.op("get", { jobId: q.job.id }, randomUUID(), "actor-b")).toThrow();
  const d = dispatch(f, q); expect(save(f, q, d.token, { ok: true, text: "x".repeat(32769), usage: { input: 100, output: 20 } })).toMatchObject({ phase: "blocked", reason: "limits" });
  const other = await queued(f); expect(f.op("dispatch", { jobId: other.job.id, profile: { id: "synthetic", revision: 2 }, token: randomUUID(), limits: { requestBytes: 1000, outputTokens: 800 } })).toMatchObject({ phase: "blocked", reason: "profile-changed" });
  const bad = await queued(f), b = dispatch(f, bad); save(f, bad, b.token); const row = f.repo.readRows("jobs", "scope-a").find(r => r.id === bad.job.id)!, payload = row.payload as any;
  payload.result[0].span.end = bad.text.length + 1; f.db.prepare("UPDATE jobs SET payload=? WHERE id=?").run(new RecordCodec(f.key).seal("jobs", "scope-a", bad.job.id, payload), bad.job.id);
  expect(() => f.op("apply", { jobId: bad.job.id, profile, sourceText: bad.text })).toThrow(); expect(f.repo.readRows("candidates", "scope-a")).toEqual([]);
});

it.each(["save", "apply"])("blocks source edits before %s and retains no normalized result or candidate", async step => {
  const f = fixture(), q = await queued(f), d = dispatch(f, q); if (step === "apply") save(f, q, d.token);
  const entry = f.entries.get(canonicalJson(q.id))!; entry.text = "I no longer use this source"; entry.contentRevision++;
  await f.registry.capture(f.access, f.adapter, q.id);
  const result = step === "save" ? save(f, q, d.token) : f.op("apply", { jobId: q.job.id, profile, sourceText: q.text });
  expect(result).toMatchObject({ phase: "blocked", reason: "source-changed" }); expect(f.repo.readRows("candidates", "scope-a")).toEqual([]);
  expect((f.repo.readRows("jobs", "scope-a").find(r => r.id === q.job.id)!.payload as any).result).toBeUndefined();
});

it("keeps model authority fields outside stored results and enforces the5-proposal boundary", async () => {
  const f = fixture(), q = await queued(f), d = dispatch(f, q), facts = JSON.parse(raw()).facts;
  save(f, q, d.token, { ok: true, text: JSON.stringify({ facts: [{ ...facts[0], scope: "global", autoAdd: true }] }), usage: { input: 100, output: 20 } });
  expect(f.op("apply", { jobId: q.job.id, profile, sourceText: q.text })).toMatchObject({ phase: "applied", outcome: { items: [] } }); expect(f.repo.readRows("evidence", "scope-a")).toEqual([]);
  const six = await queued(f), next = dispatch(f, six); expect(save(f, six, next.token, { ok: true, text: JSON.stringify({ facts: Array(6).fill(facts[0]) }), usage: { input: 100, output: 20 } })).toMatchObject({ phase: "blocked", reason: "limits" });
});

it("never recreates a lost/corrupt budget while extraction jobs exist", async () => {
  const f = fixture(), q = await queued(f); f.db.prepare("DELETE FROM jobs WHERE state='complete'").run();
  expect(() => dispatch(f, q)).toThrow("MEMORY_DATA_INVALID"); expect(() => f.op("state")).toThrow("MEMORY_DATA_INVALID");
});

it("does not reset unknown work if a damaged enqueue receipt is missing", async () => {
  const f = fixture(), q = await queued(f); dispatch(f, q);
  f.db.prepare("DELETE FROM command_receipts WHERE command_id LIKE 'natural-enqueue-%'").run();
  const replay = f.op("enqueue", { sourceRef: q.ref, sourceText: q.text, profile });
  expect(replay).toMatchObject({ id: q.job.id, phase: "result-unknown" });
  expect(() => dispatch(f, q)).toThrow("MEMORY_NATURAL_JOB_STATE"); expect(f.op("state").budget.requests).toBe(1);
});

it("assigns durable profile revisions across reopen without persisting the host credential", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "natural-profile-")); owned.push(() => fs.rmSync(root, { recursive: true, force: true }));
  let f = fixture({ file: path.join(root, "memory.sqlite") }); const definition = { provider: "synthetic", baseUrl: "https://synthetic.invalid", model: "fake", apiKey: "SYNTHETIC_PROFILE_SECRET", window: 128000 };
  expect(f.op("profile", { profileId: "synthetic", definition })).toEqual({ id: "synthetic", revision: 1 });
  const key = Buffer.from(f.key); f.close(); f = fixture({ file: path.join(root, "memory.sqlite"), key }); key.fill(0);
  expect(f.op("profile", { profileId: "synthetic", definition })).toEqual({ id: "synthetic", revision: 1 });
  expect(f.op("profile", { profileId: "synthetic", definition: { ...definition, apiKey: "SYNTHETIC_CHANGED_SECRET" } })).toEqual({ id: "synthetic", revision: 2 });
  expect(f.op("profile", { profileId: "synthetic", definition })).toEqual({ id: "synthetic", revision: 3 });
  expect(JSON.stringify(f.repo.readRows("jobs", "scope-a"))).not.toMatch(/SYNTHETIC_PROFILE_SECRET|SYNTHETIC_CHANGED_SECRET|https:\/\/synthetic/);
});

it("accepts separately reported cache usage and checks all reported input units against the reservation", async () => {
  const f = fixture(), q = await queued(f), d = dispatch(f, q);
  expect(save(f, q, d.token, { ok: true, text: raw(), usage: { input: 10, cachedInput: 2000, cacheCreation: 100, output: 5 } })).toMatchObject({ phase: "result-saved" });
  const next = await queued(f), n = dispatch(f, next); expect(save(f, next, n.token, { ok: true, text: raw(), usage: { input: 10, cachedInput: 3000, output: 5 } })).toMatchObject({ phase: "blocked", reason: "usage" });
});

it('restores a saved temporal result using its original source calendar and never auto-adds it',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'temporal-journal-'));owned.push(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'memory.sqlite'),f=fixture({file}),statement='Yesterday, I always prefer English for our chats';await f.consent(true,false);
 const s=await f.source(statement,'session-a',{occurredAt:f.time.now,timeZone:'America/New_York'}),q={...s,job:f.op('enqueue',{sourceRef:s.ref,sourceText:s.text,profile})};
 const sent=dispatch(f,q);save(f,q,sent.token);const key=Buffer.from(f.key),entries=f.entries,time={now:f.time.now+86400000};f.close();
 const reopened=fixture({file,key,entries,time});key.fill(0);
 const result=reopened.op('apply',{jobId:q.job.id,profile,sourceText:statement});
 expect(result).toMatchObject({phase:'applied',outcome:{items:[{status:'candidate'}]}});expect(reopened.repo.current('scope-a')).toEqual([]);
 const pending=reopened.repo.readRows('candidates','scope-a')[0].payload as any;
 expect(pending.fact.time).toEqual({validFrom:Date.parse('2023-11-13T05:00:00Z'),validTo:Date.parse('2023-11-14T05:00:00Z'),referenceTime:1700000000000});
});
