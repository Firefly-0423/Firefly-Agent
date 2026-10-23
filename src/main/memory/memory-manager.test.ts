import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MemoryCandidate } from "./memory-types";
const boundary = vi.hoisted(() => ({ root: "", addL2MemoryVector: vi.fn(), searchMemoryEntries: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => boundary.root } }));
vi.mock("../rag/index", () => ({ addL2MemoryVector: boundary.addL2MemoryVector, searchMemoryEntries: boundary.searchMemoryEntries }));
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); boundary.root = mkdtempSync(join(tmpdir(), "manager-contract-")); boundary.searchMemoryEntries.mockResolvedValue([]); boundary.addL2MemoryVector.mockResolvedValue("new-vector"); });
afterEach(() => rmSync(boundary.root, { recursive: true, force: true }));
const candidate = (content: string): MemoryCandidate => ({ layer: "L2", content, triggerText: content, confidence: 0.94 });
function trace(): any[] { const file = join(boundary.root, "memory-trace.log"); return existsSync(file) ? readFileSync(file, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line)) : []; }
async function modules() { return { ...(await import("./memory-manager")), ...(await import("./memory-store")) }; }
describe("memory writes and index synchronization", () => {
    it.each([false, true])("persists L2 before recording the index outcome failed=%s", async (failed) => {
        if (failed)
            boundary.addL2MemoryVector.mockRejectedValue(new Error("vector service unavailable"));
        const { memoryManager, memoryStore } = await modules();
        const incoming = candidate("用户喜欢水彩绘画");
        await memoryManager.writeMemory([incoming]);
        const records = await memoryStore.getAllL2();
        expect(records).toHaveLength(1);
        expect(records[0].syncStatus).toEqual(failed ? "sync_failed" : "synced");
        if (failed)
            expect(records[0].ragId).toBeUndefined();
        else
            expect(records[0].ragId).toEqual("new-vector");
        const events = trace();
        const added = events.findIndex(event => event.op === "l2.add" && event.l2Id === records[0].id);
        const synced = events.findIndex(event => event.op === (failed ? "l2.sync.failure" : "l2.sync.success") && event.l2Id === records[0].id);
        expect(added).toBeGreaterThanOrEqual(0);
        expect(synced).toBeGreaterThan(added);
        if (failed)
            expect(events[synced]).toMatchObject({ status: "error", error: "vector service unavailable" });
        else {
            expect(events[synced].ragId).toEqual("new-vector");
            expect(await memoryStore.getReflectionLogs()).toHaveLength(0);
            expect(boundary.addL2MemoryVector).toHaveBeenCalledWith(incoming.content, records[0].id, expect.objectContaining({ confidence: incoming.confidence }));
        }
    });
    it("rejects inferred profile claims and accepts explicit user attribution", async () => {
        const { memoryManager, memoryStore } = await modules();
        await memoryManager.writeMemory([{ ...candidate("用户只喜欢水彩"), layer: "L0", field: "longTermInterests", certainty: "inferred", attribution: "assistant_inferred", shouldWrite: true, forbiddenOverclaims: ["只"] }]);
        expect(await memoryStore.getL0()).toMatchObject({ longTermInterests: "", permanentNote: "" });
        const content = "用户希望被称为 星河";
        await memoryManager.writeMemory([{ ...candidate(content), layer: "L0", field: "preferredName", certainty: "explicit", attribution: "user_explicit", shouldWrite: true, forbiddenOverclaims: [] }]);
        expect((await memoryStore.getL0()).preferredName).toEqual(content);
    });
});
describe("conflict detection evidence", () => {
    it.each(["mapped", "text-only", "recent"] as const)("scores %s targets and keeps conflict logs separate from reflection", async (mode) => {
        const { memoryManager, memoryStore } = await modules();
        const existing = await memoryStore.addL2Memory({ content: "用户喜欢水彩", triggerText: "我喜欢水彩", sourceConversationId: "art-session", ragId: "existing-vector", isPinned: false });
        if (mode === "recent")
            (await import("./recent-injected-memory")).recordRecentMemoryInjection([existing.id]);
        boundary.searchMemoryEntries.mockResolvedValue([{ id: "existing-vector", text: existing.content, createdAt: 39, score: 0.88, metadata: mode === "text-only" ? {} : { l2Id: existing.id } }]);
        const incoming = candidate("用户不喜欢水彩");
        await memoryManager.writeMemory([incoming]);
        const conflicts = await memoryStore.getConflictLogs();
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]).toMatchObject({ status: "candidate", sourceRagId: "new-vector", targetRagId: "existing-vector", targetL2Id: existing.id, detector: "local" });
        expect(conflicts[0].scoringSignals).toMatchObject({ ragCandidate: mode !== "text-only", localContradiction: true });
        if (mode === "text-only") {
            expect(conflicts[0].resolverPriority).toEqual("none");
            expect(conflicts[0].resolverStatus).toEqual("not_queued");
        }
        else {
            expect(conflicts[0].resolverStatus).toEqual("queued");
            expect(conflicts[0].conflictScore).toBeGreaterThanOrEqual(35);
            expect(conflicts[0].resolverPriority).not.toBe("none");
            expect(conflicts[0].scoringSignals).toMatchObject({ evidenceAvailable: true });
            if (mode === "recent") {
                expect(conflicts[0].resolverPriority).toEqual("normal");
                expect(conflicts[0].scoringSignals).toMatchObject({ recentInjection: true });
            }
        }
        expect(boundary.searchMemoryEntries).toHaveBeenCalledWith(incoming.content, "user_memory", 5, { recordRecall: false });
        const events = trace();
        const marked = events.findIndex(event => event.op === "l2.conflict.mark" && event.l2Id === existing.id);
        const logged = events.findIndex(event => event.op === "conflict.log.add" && event.l2Id === conflicts[0].sourceL2Id);
        expect(marked).toBeGreaterThanOrEqual(0);
        expect(logged).toBeGreaterThan(marked);
        expect(events[logged].details).toMatchObject({ conflictStatus: "candidate", targetL2Id: existing.id, detector: "local" });
        expect(await memoryStore.getReflectionLogs()).toHaveLength(0);
    });
    it("does not log unrelated negative experiences as contradictions", async () => {
        const { memoryManager, memoryStore } = await modules();
        const existing = await memoryStore.addL2Memory({ content: "用户曾有食物过敏经历", triggerText: "食物过敏让我难受", sourceConversationId: "health-session", ragId: "existing-vector", isPinned: false });
        boundary.searchMemoryEntries.mockResolvedValue([{ id: "existing-vector", text: existing.content, score: 0.81, metadata: {} }]);
        await memoryManager.writeMemory([candidate("用户因无法出门旅行而难过")]);
        expect(await memoryStore.getConflictLogs()).toHaveLength(0);
    });
});
