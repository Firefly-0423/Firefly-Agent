import { describe, expect, it, vi } from "vitest";
import { MemoryScheduler, type MemorySchedulerDeps } from "./memory-scheduler";
import type { MemoryCandidate } from "./memory-types";
function environment(initialCount = 0) {
    let count = initialCount;
    let tail: Promise<unknown> = Promise.resolve();
    const labels: string[] = [];
    const deps: MemorySchedulerDeps = {
        enqueueTask: (label, task) => { labels.push(label); const pending = tail.then(task); tail = pending.catch(() => undefined); return pending; },
        judgeMemory: vi.fn(async () => ({ candidates: [], entities: [] })), writeMemory: vi.fn(), ingestEntities: vi.fn(),
        getL1: async () => ({ roundCount: count, recentGoals: "", recentPreferences: "", currentProject: "", generatedAt: 0 }),
        replaceL1Field: vi.fn(async (_field, value) => { count = value; }),
        runReflectionAndCompression: vi.fn(), runResolverQueueOnce: vi.fn(), runDecay: vi.fn(),
    };
    return { deps, labels, scheduler: new MemoryScheduler(deps), drain: () => tail };
}
const turns = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => ({ userInput: `question-${i + first}`, assistantReply: `response-${i + first}` }));
describe("memory maintenance cadence", () => {
    it("queues maintenance each turn but does not judge or ingest on turns one through five", async () => {
        const { scheduler, deps, labels, drain } = environment();
        for (const turn of turns(1, 5))
            scheduler.scheduleMemoryWrite(turn.userInput, turn.assistantReply);
        await drain();
        expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 5);
        expect(labels).toEqual(Array(5).fill("MemoryMaintenance"));
        expect(deps.ingestEntities).not.toHaveBeenCalled();
        expect(deps.judgeMemory).not.toHaveBeenCalled();
        expect(deps.writeMemory).not.toHaveBeenCalled();
    });
    it("judges turns one through six then uses an overlapping eight-turn window", async () => {
        const { scheduler, deps, drain } = environment();
        const candidate: MemoryCandidate = { layer: "L2", content: "User prefers watercolor", confidence: 0.89, triggerText: "I enjoy watercolor" };
        vi.mocked(deps.judgeMemory).mockResolvedValue({ candidates: [candidate], entities: [] });
        for (const turn of turns(1, 12))
            scheduler.scheduleMemoryWrite(turn.userInput, turn.assistantReply);
        await drain();
        expect(deps.judgeMemory).toHaveBeenCalledTimes(2);
        expect(vi.mocked(deps.judgeMemory).mock.calls.map(([window]) => window)).toEqual([turns(1, 6), turns(5, 12)]);
        expect(deps.writeMemory).toHaveBeenCalledWith([candidate]);
        expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 6);
        expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 12);
    });
    it("counts an ordinary turn even when the judge dependency would reject", async () => {
        const { scheduler, deps, drain } = environment();
        vi.mocked(deps.judgeMemory).mockRejectedValue(new Error("judge offline"));
        scheduler.scheduleMemoryWrite("A greeting", "A reply");
        await drain();
        expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 1);
        expect(deps.judgeMemory).not.toHaveBeenCalled();
        expect(deps.writeMemory).not.toHaveBeenCalled();
    });
    it.each([[4, "resolver"], [19, "reflection"]] as const)("runs due maintenance after saved round %i", async (initial, operation) => {
        const { scheduler, deps, drain } = environment(initial);
        scheduler.scheduleMemoryWrite("Continue", "Continuing");
        await drain();
        expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", initial + 1);
        expect(operation === "resolver" ? deps.runResolverQueueOnce : deps.runReflectionAndCompression).toHaveBeenCalled();
    });
});
