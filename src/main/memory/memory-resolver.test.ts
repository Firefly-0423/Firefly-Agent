import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const boundary = vi.hoisted(() => ({ root: "", vector: vi.fn(), structured: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => boundary.root } }));
vi.mock("../rag/index", () => ({ addL2MemoryVector: boundary.vector }));
vi.mock("./memory-llm-client", () => ({ invokeMemoryStructuredOutput: boundary.structured, getDefaultMaxOutputTokens: () => 700 }));
const summary = "用户以前喜欢水彩，现在偏好其他画种。";
beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    boundary.root = mkdtempSync(join(tmpdir(), "resolver-contract-"));
    boundary.vector.mockResolvedValue("resolved-vector");
    boundary.structured.mockResolvedValue({ resolutionType: "preference_evolution", resolvedSummary: summary, reason: "User described a changed preference", confidence: 0.88, actions: { createResolvedMemory: true, oldMemoryStatus: "superseded", newMemoryStatus: "merged", shouldAskUser: false, clarificationNeeded: false } });
});
afterEach(() => rmSync(boundary.root, { recursive: true, force: true }));
async function queued(topic = "水彩") {
    const { memoryStore } = await import("./memory-store");
    const oldMemory = await memoryStore.addL2Memory({ content: `用户喜欢${topic}`, triggerText: `我喜欢${topic}`, sourceConversationId: "before-session", ragId: "before-vector-" + topic, isPinned: false });
    const newMemory = await memoryStore.addL2Memory({ content: `用户不喜欢${topic}`, triggerText: `我现在不喜欢${topic}`, sourceConversationId: "after-session", ragId: "after-vector-" + topic, isPinned: false });
    const log = await memoryStore.appendConflictLog({ status: "candidate", sourceL2Id: newMemory.id, targetL2Id: oldMemory.id, sourceRagId: newMemory.ragId, targetRagId: oldMemory.ragId, reason: "conflicting preference", confidence: 0.8, detector: "local" });
    await memoryStore.scoreConflictLog(log.id, { conflictScore: 80, resolverPriority: "high", scoringSignals: { ragCandidate: true, evidenceAvailable: true, penalties: [] } });
    return { memoryStore, log, oldMemory, newMemory };
}
describe("conflict resolution payload", () => {
    it("loads both memory and evidence chains from the queued conflict", async () => {
        const { log, oldMemory, newMemory } = await queued();
        const resolver = await import("./memory-resolver");
        const payload = await resolver.buildResolverPayload(log.id);
        expect(payload.conflictLog.id).toEqual(log.id);
        expect(payload.newMemory.content).toEqual(newMemory.content);
        expect(payload.oldMemory.content).toEqual(oldMemory.content);
        expect(payload.newEvidence[0].quoteSnippet).toEqual("我现在不喜欢水彩");
        expect(payload.oldEvidence[0].quoteSnippet).toEqual("我喜欢水彩");
        expect(payload.conflictScore).toEqual(80);
        const resolution = await resolver.resolvePayload(payload);
        expect(resolution.resolutionType).toEqual("preference_evolution");
        expect(resolution.actions.createResolvedMemory).toEqual(true);
        expect(resolution.actions.oldMemoryStatus).toEqual("superseded");
        boundary.structured.mockRejectedValueOnce(new Error("structured output failed: NO_SCHEMA_VALID_OBJECT"));
        await expect(resolver.resolvePayload(payload)).rejects.toThrow("structured output failed");
    });
});
describe("one-item resolver queue processing", () => {
    it.each([false, true])("keeps the resolution when vector sync fails=%s", async (failed) => {
        const { memoryStore, log, oldMemory, newMemory } = await queued();
        if (failed)
            boundary.vector.mockRejectedValue(new Error("index offline"));
        const { runResolverQueueOnce } = await import("./memory-resolver");
        expect((await runResolverQueueOnce()).status).toEqual("resolved");
        const logs = await memoryStore.getConflictLogs();
        expect(logs[0].resolverStatus).toEqual("resolved");
        expect(logs[0].resolutionType).toEqual("preference_evolution");
        expect(await memoryStore.getResolverQueue()).toHaveLength(0);
        const resolved = (await memoryStore.load()).l2.find(item => item.id === logs[0].resolutionMemoryId)!;
        expect(resolved.syncStatus).toEqual(failed ? "sync_failed" : "synced");
        if (failed)
            expect(resolved.ragId).toBeUndefined();
        else {
            expect(resolved.ragId).toEqual("resolved-vector");
            expect(boundary.vector).toHaveBeenCalledWith(summary, resolved.id, expect.objectContaining({ conflictLogId: log.id, resolutionType: "preference_evolution", sourceL2Id: newMemory.id, targetL2Id: oldMemory.id }));
        }
    });
    it("limits back-to-back work and records success and rate-limit traces", async () => {
        const { memoryStore } = await queued("水彩");
        await queued("素描");
        const { runResolverQueueOnce } = await import("./memory-resolver");
        expect((await runResolverQueueOnce({ now: 2000, minIntervalMs: 60000 })).status).toEqual("resolved");
        expect((await runResolverQueueOnce({ now: 2001, minIntervalMs: 60000 })).status).toEqual("rate_limited");
        expect(await memoryStore.getResolverQueue()).toHaveLength(1);
        const operations = readFileSync(join(boundary.root, "memory-trace.log"), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line).op);
        expect(operations).toContain("resolver.run.success");
        expect(operations).toContain("resolver.queue.rate_limited");
    });
    it("records one failed attempt when the structured model request fails", async () => {
        const { memoryStore } = await queued();
        boundary.structured.mockRejectedValueOnce(new Error("structured output failed: MODEL_REQUEST_FAILED"));
        const { runResolverQueueOnce } = await import("./memory-resolver");
        expect((await runResolverQueueOnce()).status).toEqual("failed");
        expect((await memoryStore.getConflictLogs())[0]).toMatchObject({ resolverStatus: "failed", resolverAttemptCount: 1 });
    });
});
