import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { L2Input } from "./memory-store";
import type { ConflictLog } from "./memory-types";

const profile = vi.hoisted(() => ({ root: "", notify: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => profile.root } }));
vi.mock("./obsidian-exporter", () => ({ notifyMemoryChanged: profile.notify }));
beforeEach(async () => {
  await new Promise(resolve => setImmediate(resolve));
  vi.restoreAllMocks();
  vi.resetModules();
  profile.notify.mockReset();
  profile.root = mkdtempSync(join(tmpdir(), "ff-memory-contract-"));
});
afterEach(async () => {
  await new Promise(resolve => setImmediate(resolve));
  rmSync(profile.root, { force: true, recursive: true });
});
const disk = () => JSON.parse(readFileSync(join(profile.root, "memory.json"), "utf8"));
function traces() {
  const filename = join(profile.root, "memory-trace.log");
  return existsSync(filename) ? readFileSync(filename, "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
}
function traced(op: string, l2Id?: string) {
  expect(traces().some(event => event.op === op && (l2Id === undefined || event.l2Id === l2Id))).toBe(true);
}
async function fixture() {
  const { memoryStore: store } = await import("./memory-store");
  return { store, add: (patch: Partial<L2Input> = {}) => store.addL2Memory({
    content: "Keeps a herb garden", triggerText: "gardening", sourceConversationId: "garden-session",
    ragId: "vector:garden", isPinned: false, ...patch,
  }) };
}
function conflict(sourceL2Id = "garden-source", targetL2Id = "garden-target"): Omit<ConflictLog, "id" | "createdAt"> {
  return { status: "candidate", sourceL2Id, targetL2Id, sourceRagId: "vector:source", targetRagId: "vector:target",
    reason: "Garden preference changed", confidence: 0.76, detector: "local" };
}
it.each([false, true])("records a conflict without downgrading a pinned=%s memory", async pinned => {
  const h = await fixture(), entry = await h.add({ isPinned: pinned });
  const marked = await h.store.markL2Conflict(entry.id, "vector:conflicting");
  expect(marked?.conflictWith).toEqual(["vector:conflicting"]);
  expect(marked?.status).toBe(pinned ? "active" : "aging");
  expect(disk().l2[0].conflictWith).toEqual(["vector:conflicting"]);
  expect(disk().l2[0].status).toBe(pinned ? "active" : "aging");
  traced("l2.add", entry.id);
  traced("l2.conflict.mark", entry.id);
});
it("decays an unpinned memory across the ten-point boundary and leaves a pinned one unchanged", async () => {
  const h = await fixture(), loose = await h.add(), pinned = await h.add({ isPinned: true, content: "Pinned garden" });
  const state = await h.store.load();
  for (const entry of state.l2) entry.weight = 10;
  await h.store.save(state);
  expect(await h.store.decayL2Weights()).toBe(1);
  const persisted = disk().l2;
  expect(persisted.find((entry: any) => entry.id === loose.id)).toMatchObject({ weight: 9, status: "archived" });
  expect(persisted.find((entry: any) => entry.id === pinned.id)).toMatchObject({ weight: 10, status: "active" });
});
it("updates profile fields and recall counters through the persistence API", async () => {
  const h = await fixture();
  await h.store.upsertL0Field("preferredName", "River");
  const entry = await h.add();
  await h.store.updateL2RecallStats(entry.id, 13);
  expect((await h.store.getL0()).preferredName).toBe("River");
  expect((await h.store.getL0()).updatedAt).toBeGreaterThan(0);
  expect((await h.store.getAllL2()).find(item => item.id === entry.id)).toMatchObject({ weight: 13, accessCount: 1, status: "active" });
  traced("l0.update");
  traced("l2.weight.update", entry.id);
});
it("preserves active status on a low-weight recall", async () => {
  const h = await fixture(), entry = await h.add();
  await h.store.updateL2RecallStats(entry.id, 1);
  expect((await h.store.getAllL2()).find(item => item.id === entry.id)).toMatchObject({ weight: 1, status: "active" });
});
it.each(["merged", "superseded", "archived"] as const)("does not reactivate or increment recall statistics for %s", async status => {
  const h = await fixture(), entry = await h.add();
  await h.store.updateL2Status([entry.id], status);
  await h.store.updateL2RecallStats(entry.id, 57);
  expect((await h.store.getAllL2()).find(item => item.id === entry.id)).toMatchObject({ status, weight: 0, accessCount: 0 });
});
it("creates linked evidence with a bounded quote and ordered source message ids", async () => {
  const h = await fixture(), entry = await h.add({ triggerText: "garden ".repeat(80), sourceConversationId: "garden-evidence",
    sourceMessageIds: ["message:seed", "message:soil"] });
  const evidence = await h.store.getEvidenceByMemoryId(entry.id);
  expect(entry.evidenceIds).toHaveLength(1);
  expect(evidence).toHaveLength(1);
  expect(evidence[0].id).toBe(entry.evidenceIds![0]);
  expect(evidence[0].quoteSnippet.length).toBe(300);
  expect(evidence[0].conversationId).toBe("garden-evidence");
  expect(evidence[0].messageIds).toEqual(["message:seed", "message:soil"]);
  expect(evidence[0].sourceStatus).toBe("active");
  traced("evidence.add", entry.id);
});
it("removes evidence alongside a rolled-back summary", async () => {
  const h = await fixture(), entry = await h.add({ isSummary: true, syncStatus: "pending_sync", ragId: undefined });
  await h.store.deleteL2(entry.id);
  const state = await h.store.load();
  expect(state.l2.some(item => item.id === entry.id)).toBe(false);
  expect((state.evidence ?? []).some(item => item.memoryId === entry.id)).toBe(false);
});
it("persists successful vector synchronization and emits its diagnostic event", async () => {
  const h = await fixture(), entry = await h.add({ syncStatus: "pending_sync", ragId: undefined });
  expect(await h.store.markL2SyncStatus(entry.id, "synced", "vector:synchronized")).toMatchObject({
    syncStatus: "synced", ragId: "vector:synchronized",
  });
  expect(disk().l2[0]).toMatchObject({ syncStatus: "synced", ragId: "vector:synchronized" });
  traced("l2.sync.success", entry.id);
});
it("caps conflict history at one hundred independently of reflection history", async () => {
  const h = await fixture();
  for (let index = 0; index < 101; index++) await h.store.appendConflictLog(conflict(`garden:${index}`));
  const logs = await h.store.getConflictLogs();
  expect(logs).toHaveLength(100);
  expect(logs[0].sourceL2Id).toBe("garden:1");
  expect(await h.store.getReflectionLogs()).toHaveLength(0);
  expect(disk().conflictLogs).toHaveLength(100);
});
it("stores conflict scoring signals and queues eligible priorities with initial attempt metadata", async () => {
  const h = await fixture(), log = await h.store.appendConflictLog(conflict());
  const signals = { ragCandidate: true, evidenceAvailable: true, localContradiction: true, impactScope: "medium" as const, penalties: [] };
  const scored = await h.store.scoreConflictLog(log.id, { conflictScore: 58, resolverPriority: "normal", scoringSignals: signals });
  expect(scored?.conflictScore).toBe(58);
  const logs = await h.store.getConflictLogs();
  expect(logs[0].resolverPriority).toBe("normal");
  expect(logs[0].scoringSignals).toMatchObject(signals);
  traced("conflict.score", "garden-source");
  const queued = await h.store.getResolverQueue();
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ id: log.id, resolverStatus: "queued", resolverPriority: "normal", resolverAttemptCount: 0 });
  expect(queued[0].resolverQueuedAt).toBeGreaterThan(0);
  traced("resolver.queue.add", "garden-source");
});
it("queues high-priority conflicts and excludes none-priority conflicts", async () => {
  const h = await fixture(), high = await h.store.appendConflictLog(conflict("garden:urgent"));
  const low = await h.store.appendConflictLog(conflict("garden:minor"));
  await h.store.scoreConflictLog(high.id, { conflictScore: 79, resolverPriority: "high", scoringSignals: { ragCandidate: true, penalties: [] } });
  await h.store.scoreConflictLog(low.id, { conflictScore: 17, resolverPriority: "none", scoringSignals: { ragCandidate: false, localContradiction: true, penalties: [] } });
  expect((await h.store.getConflictLogs()).find(item => item.id === low.id)?.resolverStatus).toBe("not_queued");
  const queue = await h.store.getResolverQueue();
  expect(queue.map(item => item.id)).toEqual([high.id]);
  expect(queue[0]).toMatchObject({ resolverPriority: "high", resolverAttemptCount: 0, resolverStatus: "queued" });
  expect(queue[0].resolverQueuedAt).toBeGreaterThan(0);
});
it("sorts the resolver queue by priority before age", async () => {
  const h = await fixture(), idle = await h.store.appendConflictLog(conflict("garden:idle"));
  const high = await h.store.appendConflictLog(conflict("garden:high"));
  for (const [log, resolverPriority, conflictScore] of [[idle, "idle", 43], [high, "high", 84]] as const) {
    await h.store.scoreConflictLog(log.id, { conflictScore, resolverPriority, scoringSignals: { ragCandidate: true, penalties: [] } });
  }
  expect((await h.store.getResolverQueue()).map(item => item.id)).toEqual([high.id, idle.id]);
});
it("applies a preference evolution by synthesizing a memory and retiring both conflicting entries", async () => {
  const h = await fixture(), older = await h.add({ content: "Used to prefer roses" }), newer = await h.add({ content: "Now prefers lilies" });
  const log = await h.store.appendConflictLog(conflict(newer.id, older.id));
  const result = await h.store.applyResolverResolution(log.id, { resolutionType: "preference_evolution",
    resolvedSummary: "Preference changed from roses to lilies.", reason: "Current flowers changed", confidence: 0.91,
    actions: { createResolvedMemory: true, oldMemoryStatus: "superseded", newMemoryStatus: "merged", shouldAskUser: false, clarificationNeeded: false } });
  const memories = await h.store.getAllL2();
  expect(memories.find(item => item.id === result?.resolutionMemoryId)?.content).toBe("Preference changed from roses to lilies.");
  expect(memories.find(item => item.id === older.id)?.status).toBe("superseded");
  expect(memories.find(item => item.id === newer.id)?.status).toBe("merged");
  expect((await h.store.getConflictLogs())[0]).toMatchObject({ status: "resolved", resolverStatus: "resolved",
    resolutionType: "preference_evolution", resolutionConfidence: 0.91 });
});
it("records direct conflicts for clarification without synthesizing another memory", async () => {
  const h = await fixture(), older = await h.add({ content: "Call me River" }), newer = await h.add({ content: "Avoid that nickname" });
  const log = await h.store.appendConflictLog(conflict(newer.id, older.id));
  await h.store.applyResolverResolution(log.id, { resolutionType: "direct_conflict", reason: "Nickname needs clarification",
    confidence: 0.86, actions: { createResolvedMemory: false, shouldAskUser: true, clarificationNeeded: true } });
  expect(await h.store.getAllL2()).toHaveLength(2);
  expect((await h.store.getConflictLogs())[0]).toMatchObject({ status: "clarification_needed", resolverStatus: "resolved",
    shouldAskUser: true, clarificationNeeded: true });
});
it("caps reflections at fifty without trimming the conflict log", async () => {
  const h = await fixture();
  await h.store.appendConflictLog(conflict());
  for (let index = 0; index < 51; index++) await h.store.appendReflectionLog({ type: "l1_update", summary: `garden review ${index}` });
  const reviews = await h.store.getReflectionLogs();
  expect(reviews).toHaveLength(50);
  expect(reviews[0].summary).toBe("garden review 1");
  expect(await h.store.getConflictLogs()).toHaveLength(1);
  traced("reflection.log.add");
  traced("conflict.log.add");
});
it.each([
  { schemaVersion: 1, l0: { preferredName: "River" }, l2: [] },
  { schemaVersion: 2, l0: {}, l1: {}, l2: "invalid-list" },
  { schemaVersion: 2, version: 1, l0: {}, l1: {}, l2: [] },
])("preserves unsupported or incomplete persisted data %j and blocks overwriting it", async invalid => {
  const filename = join(profile.root, "memory.json"), bytes = JSON.stringify(invalid);
  writeFileSync(filename, bytes);
  const { store } = await fixture();
  await expect(store.load()).rejects.toThrow("MEMORY_STORE_READ_FAILED");
  await expect(store.save({ schemaVersion: 2 } as never)).rejects.toThrow("MEMORY_STORE_READ_FAILED");
  expect(readFileSync(filename, "utf8")).toBe(bytes);
});
it("notifies the vault only after the transformed profile is saved", async () => {
  const { store } = await fixture();
  await store.load();
  await vi.waitFor(() => expect(profile.notify).toHaveBeenCalled());
  profile.notify.mockClear();
  const operations: string[] = [];
  const originalLoad = store.load.bind(store), originalSave = store.save.bind(store);
  vi.spyOn(store, "load").mockImplementation(async () => { operations.push("read"); return originalLoad(); });
  vi.spyOn(store, "save").mockImplementation(async state => { operations.push(`write:${state.l0.preferredName}`); await originalSave(state); });
  profile.notify.mockImplementation(() => { expect(disk().l0.preferredName).toBe("River"); operations.push("publish"); });
  await store.upsertL0Field("preferredName", "River");
  await vi.waitFor(() => expect(operations).toContain("publish"));
  expect(operations).toEqual(["read", "write:River", "publish"]);
});
