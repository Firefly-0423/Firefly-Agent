import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createSmhFixture } from "../memory-context/smh-fixture.test-support";
import { createMainSourceProvider } from "../memory-sources/main-source-provider";
import { canonicalJson } from "../memory-core/repository-types";

const owned: ReturnType<typeof fixture>[] = [], profile = { id: "synthetic", revision: 1 };
afterEach(() => { for (const f of owned.splice(0)) { f.close(); fs.rmSync(f.root, { recursive: true, force: true }); } });
function fixture() {
  let fail: string | undefined;
  const f = createSmhFixture(fs.mkdtempSync(path.join(os.tmpdir(), "natural-add-")), { fault: stage => { if (stage === fail) throw Error("SYNTHETIC_FAULT"); } });
  const op = (operation: string, body: Record<string, unknown> = {}): any => f.repo.policyCommand({ kind: "naturalJob", scopeKey: "scope-a", commandId: randomUUID(), body: { actorKey: "actor-a", operation, ...body } });
  const settings = createMainSourceProvider({ providerId: "synthetic", authorize: (scope, id) => scope === "scope-a" && id.sessionId === "memory-settings-user-events-v1", withLease: async (id, run) => run(async () => JSON.parse(fs.readFileSync(path.join(f.root, "synthetic-provider.json"), "utf8"))[canonicalJson(id)]) });
  async function consent(language: boolean, responseStyle: boolean) {
    const revision = op("state").config.revision, text = `Natural memory consent revision ${revision}; language=${language}; responseStyle=${responseStyle}`, id = { providerId: "synthetic", sessionId: "memory-settings-user-events-v1", messageId: randomUUID() };
    f.write(id, { text, role: "user", trust: "direct-user-event" });
    op("configure", { expectedRevision: revision, language, responseStyle, sourceText: text, sourceRef: await f.registry.capture(f.access, settings, id) });
  }
  async function saved(text = "I always prefer English for our chats", attribute = "language", value = "English", polarity = "positive", source?: Awaited<ReturnType<typeof f.source>>) {
    const s = source ?? await f.source(text), job = op("enqueue", { sourceRef: s.ref, sourceText: text, profile }), token = randomUUID();
    op("dispatch", { jobId: job.id, token, profile, limits: { requestBytes: 1000, outputTokens: 800 } });
    op("save", { jobId: job.id, token, profile, sourceText: text, result: { ok: true, text: JSON.stringify({ facts: [{ subject: "user", attribute, value, polarity, status: "asserted", quote: text, reason: "direct user statement" }] }), usage: { input: 50, output: 10 } } });
    return { ...s, job, apply: () => op("apply", { jobId: job.id, profile, sourceText: text }) };
  }
  const out = { ...f, op, consent, saved, fault: (stage?: string) => { fail = stage; } }; owned.push(out); return out;
}

it("defaults to pending and cannot backfill a saved result after later consent", async () => {
  const f = fixture(), q = await f.saved(); await f.consent(true, true);
  expect(q.apply()).toMatchObject({ phase: "applied", outcome: { items: [{ status: "candidate" }] } }); expect(f.repo.current("scope-a")).toEqual([]);
});

it.each([
  ["language", "I always prefer English for our chats", "English", "en", true, false],
  ["language", "我长期偏好用中文交流", "中文", "zh", true, false],
  ["response-style", "I always prefer concise replies", "concise", "concise", false, true],
  ["response-style", "我一直偏好详细回复", "详细", "detailed", false, true],
] as const)("adds opted-in %s only with program evidence: %s", async (attribute, text, value, canonical, language, style) => {
  const f = fixture(); await f.consent(language, style); const q = await f.saved(text, attribute, value), result = q.apply();
  expect(result).toMatchObject({ phase: "applied", outcome: { items: [{ status: "active", factRevision: 1 }] } });
  const facts = await f.policy.recall(f.actor); expect(facts).toHaveLength(1);
  expect(facts[0]).toMatchObject({ revision: 1, activationReason: "policyAccepted", policyVersion: "natural-add-v1", recordedAt: 1700000000000, acceptedAt: 1700000000000, typed: { version: 2, attribute, value: canonical, polarity: "positive" } });
  expect((await f.policy.candidates(f.actor, { limit: 100 })).items).toEqual([]);
  expect((await f.policy.audit(f.actor, facts[0].factId)).supports).toMatchObject([{ kind: "automatic", proof: null, sourceRef: q.ref }]);
  expect(q.apply()).toEqual(result); expect(f.repo.history("scope-a", facts[0].factId)).toHaveLength(1);
});

it.each([
  ["response-style", "I always prefer concise replies", "concise", "positive"],
  ["language", "I usually prefer English", "English", "positive"],
  ["language", "I don't prefer English", "English", "negative"],
  ["tool", "My editor is Vim", "Vim", "positive"],
  ["preference", "I like tea", "tea", "positive"],
  ["form-of-address", "Sparrow是我习惯用的称呼", "Sparrow", "positive"],
] as const)("holds non-opted, non-whitelisted or negative %s for confirmation: %s", async (attribute, text, value, polarity) => {
  const f = fixture(); await f.consent(true, false); const q = await f.saved(text, attribute, value, polarity);
  expect(q.apply()).toMatchObject({ outcome: { items: [{ status: "candidate" }] } }); expect(f.repo.current("scope-a")).toEqual([]);
});

it("adds independent canonical support without replacing a fact or counting same-source replay twice", async () => {
  const f = fixture(); await f.consent(true, false); const first = await f.saved(), active = first.apply().outcome.items[0];
  const next = await f.saved("我长期偏好用英语交流", "language", "英语"); expect(next.apply()).toMatchObject({ outcome: { items: [{ status: "active", factId: active.factId, factRevision: 1, reason: "duplicate-support" }] } });
  expect(f.repo.current("scope-a")).toHaveLength(1); expect(f.repo.history("scope-a", active.factId)).toHaveLength(1);
  let audit = await f.policy.audit(f.actor, active.factId); expect(audit.supports).toHaveLength(2); expect(audit.supports.every(s => s.kind === "automatic")).toBe(true);
  first.apply(); next.apply(); expect(f.op("enqueue", { sourceRef: first.ref, sourceText: "I always prefer English for our chats", profile }).id).toBe(first.job.id);
  audit = await f.policy.audit(f.actor, active.factId); expect(audit.supports).toHaveLength(2);
});

it("holds conflicts and explicitly denied duplicates without overwriting or adding support", async () => {
  const f = fixture(); await f.consent(true, false); const first = await f.saved(), active = first.apply().outcome.items[0];
  const conflict = await f.saved("我长期偏好用中文交流", "language", "中文"); expect(conflict.apply()).toMatchObject({ outcome: { items: [{ status: "candidate" }] } });
  expect((await f.policy.recall(f.actor))[0]).toMatchObject({ factId: active.factId, revision: 1, typed: { value: "en" } });
  const proof = await f.source("这条不准确"); await f.policy.act(f.actor, await f.policy.event(f.actor, { kind: "deny", nonce: randomUUID(), factId: active.factId, revision: 1, sourceRef: proof.ref }));
  const duplicate = await f.saved(); expect(duplicate.apply()).toMatchObject({ outcome: { items: [{ status: "candidate" }] } });
  expect((await f.policy.audit(f.actor, active.factId)).supports).toHaveLength(1); expect(f.repo.current("scope-a")[0].revision).toBe(1);
});

it("off/on revision changes fence already-saved work while a new source can use new consent", async () => {
  const f = fixture(); await f.consent(true, false); const old = await f.saved(); await f.consent(false, false); await f.consent(true, false);
  expect(old.apply()).toMatchObject({ outcome: { items: [{ status: "candidate" }] } }); expect(f.repo.current("scope-a")).toEqual([]);
  const fresh = await f.saved(); expect(fresh.apply()).toMatchObject({ outcome: { items: [{ status: "active" }] } });
});

it("explicit correction wins over a saved conflicting result and forgetting blocks late and fresh reintroduction", async () => {
  const f = fixture(); await f.consent(true, false); const first = await f.saved(), active = first.apply().outcome.items[0], late = await f.saved();
  const correction = await f.source("我默认用中文"); await f.policy.act(f.actor, await f.policy.event(f.actor, { kind: "correct", nonce: randomUUID(), factId: active.factId, revision: 1, sourceRef: correction.ref }));
  expect(late.apply()).toMatchObject({ outcome: { items: [{ status: "candidate" }] } }); expect((await f.policy.recall(f.actor))[0]).toMatchObject({ revision: 2, typed: { value: "zh" } });
  const beforeForget = await f.saved("我长期偏好用中文交流", "language", "中文");
  await f.policy.act(f.actor, await f.policy.event(f.actor, { kind: "forget", nonce: randomUUID(), factId: active.factId, revision: 2 }));
  expect(beforeForget.apply()).toMatchObject({ phase: "blocked", reason: "suppressed" });
  const fresh = await f.saved("我长期偏好用中文交流", "language", "中文"); expect(fresh.apply()).toMatchObject({ outcome: { items: [{ status: "suppressed" }] } }); expect(await f.policy.recall(f.actor)).toEqual([]);
  first.apply(); expect(await f.policy.recall(f.actor)).toEqual([]);
});

it("ADD/support and completion share the same rollback boundary", async () => {
  const f = fixture(); await f.consent(true, false); const q = await f.saved(); f.fault("after-record"); expect(q.apply).toThrow("SYNTHETIC_FAULT"); f.fault();
  expect(f.op("get", { jobId: q.job.id }).phase).toBe("result-saved"); expect(f.repo.current("scope-a")).toEqual([]); expect(f.repo.readRows("candidates", "scope-a")).toEqual([]);
  const active = q.apply().outcome.items[0]; expect(active.status).toBe("active"); expect((await f.policy.audit(f.actor, active.factId)).supports).toHaveLength(1);
});

it("invalidates an unknown predecessor and its already-issued confirmation when the new fact is added", async () => {
  const f = fixture(); await f.consent(true, false); const text = "I always prefer English for our chats", s = await f.source(text), unknown = (await f.policy.integrate(f.actor, s.ref)).items[0], proof = await f.source("确认这一条");
  const stale = await f.policy.event(f.actor, { kind: "confirm", nonce: randomUUID(), candidateId: unknown.candidateId, revision: 1, sourceRef: proof.ref });
  const q = await f.saved(text, "language", "English", "positive", s); expect(q.apply()).toMatchObject({ outcome: { items: [{ status: "active" }] } });
  await expect(f.policy.act(f.actor, stale)).rejects.toThrow("MEMORY_REVISION_CONFLICT"); expect((await f.policy.candidates(f.actor, { limit: 100 })).items).toEqual([]);
});

it("does not repair an ineligible primary source with automatic duplicate evidence", async () => {
  const f = fixture(); await f.consent(true, false); const first = await f.saved(), active = first.apply().outcome.items[0], next = await f.saved();
  f.write(first.id, { text: "user edited the declaration", role: "user", trust: "direct-user-event" }); await f.registry.capture(f.access, f.adapter, first.id);
  expect(next.apply()).toMatchObject({ outcome: { items: [{ status: "candidate" }] } }); expect(await f.policy.recall(f.actor)).toEqual([]);
  expect((await f.policy.audit(f.actor, active.factId)).supports).toHaveLength(1); expect(f.repo.current("scope-a")[0].revision).toBe(1);
});

it("does not count an edit to a supporting message as a third independent source", async () => {
  const f = fixture(); await f.consent(true, false); const first = await f.saved(), active = first.apply().outcome.items[0], second = await f.saved(); second.apply();
  const text = "I always prefer English for our chats."; f.write(second.id, { text, role: "user", trust: "direct-user-event" }); const ref = await f.registry.capture(f.access, f.adapter, second.id);
  const edit = await f.saved(text, "language", "English", "positive", { id: second.id, ref }); expect(edit.apply()).toMatchObject({ outcome: { items: [{ status: "candidate" }] } });
  expect((await f.policy.audit(f.actor, active.factId)).supports).toHaveLength(2); expect(f.repo.history("scope-a", active.factId)).toHaveLength(1);
});

it("rejects a public automatic-authorization flag without altering a saved job", async () => {
  const f = fixture(), q = await f.saved();
  expect(() => f.op("apply", { jobId: q.job.id, profile, sourceText: "I always prefer English for our chats", autoAdd: true })).toThrow("MEMORY_INPUT_INVALID");
  expect(f.op("get", { jobId: q.job.id }).phase).toBe("result-saved"); expect(q.apply()).toMatchObject({ outcome: { items: [{ status: "candidate" }] } }); expect(f.repo.current("scope-a")).toEqual([]);
});
