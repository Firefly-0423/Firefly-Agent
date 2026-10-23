import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createSmhFixture } from "../memory-context/smh-fixture.test-support";
import type { ShadowModel } from "../memory-shadow/shadow-model-call";
import * as runnerModule from "./natural-extraction-runner";
import {projectKeyForWorkspaceRoot} from "./project-scope";
import {createMainSourceProvider} from "../memory-sources/main-source-provider";
import {canonicalJson} from "../memory-core/repository-types";

const owned: ReturnType<typeof createSmhFixture>[] = [], profile = { id: "synthetic", revision: 1 }, text = "I always prefer English for our chats";
afterEach(() => { for (const f of owned.splice(0)) { f.close(); fs.rmSync(f.root, { recursive: true, force: true }); } });
function fixture(root = fs.mkdtempSync(path.join(os.tmpdir(), "natural-runner-")), key?: Uint8Array) { const f = createSmhFixture(root, { key }); owned.push(f); return f; }
const raw = JSON.stringify({ facts: [{ subject: "user", attribute: "language", value: "English", polarity: "positive", status: "asserted", quote: text, reason: "direct user statement" }] });
function model(input: { before?: () => Promise<void>; limits?: unknown; failed?: boolean; usage?: unknown } = {}) {
  const send = vi.fn(async () => { await input.before?.(); return { ok: true, text: raw, usage: input.usage === undefined ? { input: 50, output: 10 } : input.usage }; });
  const prepare = vi.fn(() => ({ ok: true, limits: input.limits ?? { requestBytes: 1000, outputTokens: 800 }, send }));
  return { value: { profile, assertCurrent() { if (input.failed) throw Error("MEMORY_RUN_PROFILE_CHANGED"); }, prepare } as ShadowModel, prepare, send };
}
function runner(f: ReturnType<typeof fixture>) {
  expect(typeof runnerModule.createNaturalExtractionRunner).toBe("function"); return runnerModule.createNaturalExtractionRunner({ policy: f.policy });
}
const op = (f: ReturnType<typeof fixture>, operation: string, body: Record<string, unknown> = {}): any => f.repo.policyCommand({ kind: "naturalJob", scopeKey: "scope-a", commandId: randomUUID(), body: { actorKey: "actor-a", operation, ...body } });
async function consent(f: ReturnType<typeof fixture>, enabled: boolean) {
  const revision = op(f, "state").config.revision, sourceText = `Natural memory consent revision ${revision}; language=${enabled}; responseStyle=false`, id = { providerId: "synthetic", sessionId: "memory-settings-user-events-v1", messageId: randomUUID() };
  f.write(id, { text: sourceText, role: "user", trust: "direct-user-event" });
  const adapter = createMainSourceProvider({ providerId: "synthetic", authorize: (scope, identity) => scope === "scope-a" && identity.sessionId === id.sessionId, withLease: async (identity, run) => run(async () => JSON.parse(fs.readFileSync(path.join(f.root, "synthetic-provider.json"), "utf8"))[canonicalJson(identity)]) });
  op(f, "configure", { expectedRevision: revision, language: enabled, responseStyle: false, sourceText, sourceRef: await f.registry.capture(f.access, adapter, id) });
}

it.each(["enqueue", "dispatch", "save", "apply"] as const)("rechecks live project scope at %s dispatch after an awaited source/job read", async operation => {
  const f = fixture(); await consent(f, true); const source = await f.source(text); let project: string | undefined;
  const actor = f.actorAuthority.bindActor(f.access, f.adapter, f.identity, { project: () => project });
  const token = randomUUID(), job = operation === "enqueue" ? undefined : op(f, "enqueue", { sourceRef: source.ref, sourceText: text, profile });
  if (operation === "save" || operation === "apply") op(f, "dispatch", { jobId: job.id, token, profile, limits: { requestBytes: 1000, outputTokens: 800 } });
  if (operation === "apply") op(f, "save", { jobId: job.id, token, profile, sourceText: text, result: { ok: true, text: raw, usage: { input: 50, output: 10 } } });
  const before = op(f, "state"), phase = job ? op(f, "get", { jobId: job.id }).phase : undefined;
  if (operation === "enqueue") {
    const read = f.registry.readEvidence.bind(f.registry);
    vi.spyOn(f.registry, "readEvidence").mockImplementation(async (...args) => { const value = await read(...args); project = projectKeyForWorkspaceRoot("E:/synthetic-project"); return value; });
  } else {
    const read = f.transport.policyCommand.bind(f.transport);
    vi.spyOn(f.transport, "policyCommand").mockImplementation(async command => { const value = await read(command); const c = command as any; if (c.kind === "naturalJob" && c.body.operation === "get") project = projectKeyForWorkspaceRoot("E:/synthetic-project"); return value; });
  }
  const body = operation === "enqueue" ? { sourceRef: source.ref, profile } : { jobId: job.id, profile, ...(operation === "dispatch" ? { token, limits: { requestBytes: 1000, outputTokens: 800 } } : operation === "save" ? { token, sourceText: text, result: { ok: true, text: raw, usage: { input: 50, output: 10 } } } : { sourceText: text }) };
  await expect(f.policy.naturalCommand(actor, operation, body)).rejects.toThrow("MEMORY_POLICY_NATURAL_SCOPE_DENIED");
  expect(project).toBeDefined(); expect(f.repo.current("scope-a")).toEqual([]); expect(op(f, "state").budget.requests).toBe(before.budget.requests);
  if (job) expect(op(f, "get", { jobId: job.id }).phase).toBe(phase); else expect(op(f, "lookup", { sourceRef: source.ref })).toBeNull();
});

it.each(["dispatch", "save", "apply"] as const)("rechecks live model configuration at actual %s dispatch during recovery", async operation => {
  const f = fixture(); await consent(f, true); const source = await f.source(text), job = op(f, "enqueue", { sourceRef: source.ref, sourceText: text, profile }), token = randomUUID();
  if (operation === "apply") {
    op(f, "dispatch", { jobId: job.id, token, profile, limits: { requestBytes: 1000, outputTokens: 800 } });
    op(f, "save", { jobId: job.id, token, profile, sourceText: text, result: { ok: true, text: raw, usage: { input: 50, output: 10 } } });
  }
  let armed = operation !== "save", invalid = false;
  const m = model({ before: async () => { armed = true; } }); m.value.assertCurrent = () => { if (invalid) throw Error("MEMORY_RUN_PROFILE_CHANGED"); };
  const read = f.transport.policyCommand.bind(f.transport);
  vi.spyOn(f.transport, "policyCommand").mockImplementation(async command => { const value = await read(command); const c = command as any; if (armed && c.kind === "naturalJob" && c.body.operation === "get") invalid = true; return value; });
  const r = runner(f); await r.recover(f.actor, () => m.value);
  expect(invalid).toBe(true); expect(op(f, "get", { jobId: job.id })).toMatchObject({ phase: "blocked", reason: "profile-changed" }); expect(f.repo.current("scope-a")).toEqual([]);
  expect(m.send).toHaveBeenCalledTimes(operation === "save" ? 1 : 0); expect(m.prepare).toHaveBeenCalledTimes(operation === "apply" ? 0 : 1);
  expect(op(f, "state").budget.requests).toBe(operation === "dispatch" ? 0 : 1); await r.close();
});

it.each(["unsent", "result-unknown", "result-saved", "applied"] as const)("restores %s with the correct actual fake-send/prepare counts", async phase => {
  let f = fixture(); const source = await f.source(text), job = op(f, "enqueue", { sourceRef: source.ref, sourceText: text, profile }), token = randomUUID();
  if (phase !== "unsent") { op(f, "dispatch", { jobId: job.id, token, profile, limits: { requestBytes: 1000, outputTokens: 800 } }); if (phase !== "result-unknown") { op(f, "save", { jobId: job.id, token, profile, sourceText: text, result: { ok: true, text: raw, usage: { input: 50, output: 10 } } }); if (phase === "applied") op(f, "apply", { jobId: job.id, profile, sourceText: text }); } }
  const root = f.root, key = Buffer.from(f.key); f.close(); owned.splice(owned.indexOf(f), 1); f = fixture(root, key); key.fill(0);
  const m = model(), factory = vi.fn(async () => m.value), r = runner(f); await r.recover(f.actor, factory);
  expect(m.send).toHaveBeenCalledTimes(phase === "unsent" ? 1 : 0); expect(m.prepare).toHaveBeenCalledTimes(phase === "unsent" ? 1 : 0);
  expect(factory).toHaveBeenCalledTimes(["unsent", "result-saved"].includes(phase) ? 1 : 0);
  expect(op(f, "get", { jobId: job.id }).phase).toBe(phase === "result-unknown" ? "result-unknown" : "applied"); await r.close();
});

it("serializes dispatch across two runner instances without holding the writer during send", async () => {
  const f = fixture(), s = await f.source(text); let arrived!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const m = model({ before: async () => { arrived(); await gate; } }), first = runner(f), second = runner(f);
  const one = first.run(f.actor, s.ref, m.value); await started; const two = second.run(f.actor, s.ref, m.value);
  expect(await two).toMatchObject({ phase: "result-unknown" }); expect(op(f, "state").budget.requests).toBe(1);
  release(); expect(await one).toMatchObject({ phase: "applied" }); expect(m.send).toHaveBeenCalledOnce(); await first.close(); await second.close();
});

it.each([{ requestBytes: 16385, outputTokens: 800 }, { requestBytes: 1000, outputTokens: 4096 }, {}, { requestBytes: 1000, outputTokens: NaN }])("rejects invalid proved wire limits before enqueue: %j", async limits => {
  const f = fixture(), s = await f.source(text), m = model({ limits }), r = runner(f); await r.run(f.actor, s.ref, m.value);
  expect(m.send).not.toHaveBeenCalled(); expect(f.repo.readRows("jobs", "scope-a")).toEqual([]); await r.close();
});

it.each(["temporary", "project", "profile"])("denies %s before persistent queue/send", async kind => {
  const f = fixture(), s = await f.source(text), actor = kind === "temporary" ? f.actorAuthority.bindActor(f.access, f.adapter, f.identity, { sessionMode: "temporary" }) : kind === "project" ? f.actorAuthority.bindActor(f.access, f.adapter, f.identity, { project: () => projectKeyForWorkspaceRoot("E:/synthetic-project") }) : f.actor;
  const m = model({ failed: kind === "profile" }), r = runner(f); await expect(r.run(actor, s.ref, m.value)).rejects.toThrow(); expect(m.send).not.toHaveBeenCalled(); expect(f.repo.readRows("jobs", "scope-a")).toEqual([]); await r.close();
});

it("source mutation during fake send blocks late output and close drains its real pending call", async () => {
  const f = fixture(), s = await f.source(text); let arrived!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const m = model({ before: async () => { arrived(); await gate; } }), r = runner(f), pending = r.run(f.actor, s.ref, m.value); await started;
  f.write(s.id, { text: "user changed source", role: "user", trust: "direct-user-event" }); await f.registry.capture(f.access, f.adapter, s.id);
  release(); await pending; expect(f.repo.readRows("candidates", "scope-a")).toEqual([]); expect(op(f, "list").jobs).toEqual([]); await r.close();
});

it("shutdown waits for an already-dispatched fake provider and leaves its unknown work unsent on restart", async () => {
  const f = fixture(), s = await f.source(text); let arrived!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const m = model({ before: async () => { arrived(); await gate; } }), r = runner(f), pending = r.run(f.actor, s.ref, m.value); await started;
  let closed = false; const closing = r.close().then(() => { closed = true; }); await new Promise<void>(setImmediate); expect(closed).toBe(false); release(); await Promise.allSettled([pending, closing]);
  expect(op(f, "list").jobs).toMatchObject([{ phase: "result-unknown" }]); expect(f.repo.readRows("candidates", "scope-a")).toEqual([]);
  const next = runner(f), after = model(); await next.recover(f.actor, async () => after.value); expect(after.send).not.toHaveBeenCalled(); await next.close();
});

it.each([null, { input: NaN, output: 5 }, { input: 1000000, output: 5 }])("missing or corrupt provider usage cannot produce a candidate or another dispatch: %j", async usage => {
  const f = fixture(), s = await f.source(text), r = runner(f), m = model({ usage });
  expect(await r.run(f.actor, s.ref, m.value)).toMatchObject({ phase: "blocked", reason: "usage" }); expect(op(f, "state").budget.closed).toBe(true); expect(f.repo.readRows("candidates", "scope-a")).toEqual([]);
  const next = await f.source(text); expect(await r.run(f.actor, next.ref, m.value)).toMatchObject({ phase: "blocked", reason: "budget" }); expect(m.send).toHaveBeenCalledOnce(); await r.close();
});

it("consent off/on while a fake send is blocked never authorizes its old result", async () => {
  const f = fixture(); await consent(f, true); const s = await f.source(text); let arrived!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }), r = runner(f), m = model({ before: async () => { arrived(); await gate; } });
  const pending = r.run(f.actor, s.ref, m.value); await started; await consent(f, false); await consent(f, true); release();
  expect(await pending).toMatchObject({ phase: "applied", outcome: { items: [{ status: "candidate" }] } }); expect(f.repo.current("scope-a")).toEqual([]); await r.close();
});

it("forget is synchronous during a blocked fake send and the late result cannot resurrect the fact", async () => {
  const f = fixture(); await consent(f, true); const r = runner(f), first = await f.source(text), active = await r.run(f.actor, first.ref, model().value);
  if (!active.id) throw Error("expected active job"); const factId = active.outcome!.items[0].factId!, next = await f.source(text); let arrived!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }), m = model({ before: async () => { arrived(); await gate; } });
  const pending = r.run(f.actor, next.ref, m.value); await started;
  await f.policy.act(f.actor, await f.policy.event(f.actor, { kind: "forget", nonce: randomUUID(), factId, revision: 1 })); expect(f.repo.current("scope-a")).toEqual([]);
  release(); expect(await pending).toMatchObject({ phase: "blocked", reason: "suppressed" }); expect(await f.policy.recall(f.actor)).toEqual([]); await r.close();
});

it("profile invalidation while a fake send is blocked prevents result application", async () => {
  const f = fixture(), s = await f.source(text); let arrived!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }), input = { failed: false, before: async () => { arrived(); await gate; } }, m = model(input), r = runner(f);
  const pending = r.run(f.actor, s.ref, m.value); await started; input.failed = true; release();
  expect(await pending).toMatchObject({ phase: "blocked", reason: "profile-changed" }); expect(f.repo.readRows("candidates", "scope-a")).toEqual([]); await r.close();
});
