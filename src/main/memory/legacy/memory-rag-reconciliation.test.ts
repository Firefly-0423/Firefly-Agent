import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reconcileMemoryRag, backupMemoryRagFiles, type MemoryRagReconciliationDeps, type ReconciliationVector } from "./memory-rag-reconciliation";
import type { L2Memory } from "./memory-types";
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true }); });
function memory(id: string, patch: Partial<L2Memory> = {}): L2Memory { return { id, content: `fact-${id}`, ragId: `vector-${id}`, triggerText: "source text", sourceConversationId: "reconcile-session", createdAt: 5, lastAccessedAt: 5, accessCount: 0, weight: 0, isPinned: false, status: "active", syncStatus: "synced", ...patch }; }
function fixture(memories: L2Memory[], vectors: ReconciliationVector[]) {
    const deps: MemoryRagReconciliationDeps = { getMemories: async () => memories, getVectors: () => vectors, backup: vi.fn(async () => undefined), addVector: vi.fn(async (_text, id) => "repaired-" + id), markSynced: vi.fn(), markSyncFailed: vi.fn(), deleteVectors: vi.fn(), warn: vi.fn() };
    return deps;
}
const vector = (id: string): ReconciliationVector => ({ id: `vector-${id}`, text: `fact-${id}`, metadata: { l2Id: id } });
describe("memory and semantic-index agreement", () => {
    it("repairs absent and mismapped vectors, relinks pending records, and removes stale vectors", async () => {
        const deps = fixture([
            memory("consistent"), memory("absent"), memory("pending", { syncStatus: "pending_sync" }), memory("retired", { status: "archived" }), memory("mismapped"),
        ], [vector("consistent"), vector("pending"), vector("retired"), { ...vector("mismapped"), metadata: { l2Id: "wrong-target" } }, vector("orphan")]);
        const report = await reconcileMemoryRag(deps);
        expect(deps.backup).toHaveBeenCalledTimes(1);
        expect(deps.addVector).toHaveBeenCalledTimes(2);
        expect(deps.addVector).toHaveBeenCalledWith("fact-absent", "absent", expect.any(Object));
        expect(deps.addVector).toHaveBeenCalledWith("fact-mismapped", "mismapped", expect.any(Object));
        expect(deps.markSynced).toHaveBeenCalledWith("pending", "vector-pending");
        expect(deps.deleteVectors).toHaveBeenCalledWith(["vector-retired", "vector-mismapped", "vector-orphan"]);
        expect(report).toEqual({ rebuilt: 2, relinked: 1, deleted: 3, failed: 0, changed: true });
    });
    it("does not back up or mutate already consistent stores", async () => {
        const deps = fixture([memory("consistent")], [vector("consistent")]);
        expect((await reconcileMemoryRag(deps)).changed).toEqual(false);
        expect(deps.backup).not.toHaveBeenCalled();
        expect(deps.addVector).not.toHaveBeenCalled();
        expect(deps.deleteVectors).not.toHaveBeenCalled();
    });
    it("rebuilds mapped vectors whose text is outdated", async () => {
        const deps = fixture([memory("edited", { content: "Revised exercise plan" })], [vector("edited")]);
        expect(await reconcileMemoryRag(deps)).toEqual({ rebuilt: 1, relinked: 0, deleted: 1, failed: 0, changed: true });
        expect(deps.addVector).toHaveBeenCalledWith("Revised exercise plan", "edited", expect.any(Object));
        expect(deps.markSynced).toHaveBeenCalledWith("edited", "repaired-edited");
        expect(deps.deleteVectors).toHaveBeenCalledWith(["vector-edited"]);
    });
    it("continues repairing after marking one failed synchronization", async () => {
        const deps = fixture([memory("unavailable"), memory("repairable")], []);
        vi.mocked(deps.addVector).mockRejectedValueOnce(new Error("embedding offline")).mockResolvedValueOnce("replacement-vector");
        expect(await reconcileMemoryRag(deps)).toMatchObject({ rebuilt: 1, failed: 1, changed: true });
        expect(deps.markSyncFailed).toHaveBeenCalledWith("unavailable", expect.any(Error));
        expect(deps.markSynced).toHaveBeenCalledWith("repairable", "replacement-vector");
    });
    it("backs up both stores and retains exactly the newest two snapshots", () => {
        const folder = mkdtempSync(join(tmpdir(), "reconcile-snapshots-"));
        folders.push(folder);
        mkdirSync(join(folder, "rag-data"));
        writeFileSync(join(folder, "memory.json"), "facts");
        writeFileSync(join(folder, "rag-data", "memory-store.json"), "embeddings");
        for (const at of [400, 500, 600])
            backupMemoryRagFiles(folder, at, 2);
        const target = join(folder, "memory-reconcile-backups");
        expect(readdirSync(target).sort()).toEqual(["memory-store.500.json", "memory-store.600.json", "memory.500.json", "memory.600.json"]);
        expect(readFileSync(join(target, "memory.600.json"), "utf8")).toEqual("facts");
        expect(readFileSync(join(target, "memory-store.600.json"), "utf8")).toEqual("embeddings");
    });
});
