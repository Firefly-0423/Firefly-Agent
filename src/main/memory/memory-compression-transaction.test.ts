import { describe, expect, it, vi } from "vitest";
import { commitMemoryCompression, type CompressionTransactionDeps } from "./memory-compression-transaction";
const request = { content: "User is learning two instruments", triggerText: "I practice violin and piano", sourceConversationId: "music-session", sources: [{ id: "violin-memory", ragId: "violin-vector", status: "active" as const }, { id: "piano-memory", ragId: "piano-vector", status: "active" as const }] };
function fixture() {
    const events: string[] = [];
    const step = (name: string) => vi.fn(async () => { events.push(name); });
    const deps: CompressionTransactionDeps = {
        createSummary: vi.fn(async () => { events.push("new-record"); return { id: "combined-memory" }; }),
        addSummaryVector: vi.fn(async () => { events.push("new-vector"); return "combined-vector"; }),
        markSummarySynced: step("synced"), archiveSources: step("archive"), restoreSources: step("restore"),
        deactivateSummary: step("deactivate"), deleteSummary: step("remove-record"), deleteVectors: vi.fn(async (ids) => { events.push("remove:" + ids.join("|")); }), warn: vi.fn(),
    };
    return { events, deps };
}
describe("compression commit and rollback", () => {
    it("syncs the summary before archiving sources and deleting their vectors", async () => {
        const { events, deps } = fixture();
        expect(await commitMemoryCompression(request, deps)).toEqual({ summaryId: "combined-memory", ragId: "combined-vector" });
        expect(events).toEqual(["new-record", "new-vector", "synced", "archive", "remove:violin-vector|piano-vector"]);
        expect(deps.addSummaryVector).toHaveBeenCalledWith(request.content, "combined-memory", expect.objectContaining({ isSummary: true, subEntryIds: ["violin-memory", "piano-memory"] }));
    });
    it("leaves source memories active if vector creation fails", async () => {
        const { events, deps } = fixture();
        vi.mocked(deps.addSummaryVector).mockRejectedValue(new Error("vector creation refused"));
        await expect(commitMemoryCompression(request, deps)).rejects.toThrow("vector creation refused");
        expect(deps.archiveSources).not.toHaveBeenCalled();
        expect(events).toEqual(["new-record", "deactivate", "remove-record"]);
    });
    it("restores sources and removes the partial summary after archiving fails", async () => {
        const { events, deps } = fixture();
        vi.mocked(deps.archiveSources).mockImplementation(async () => { events.push("archive"); throw new Error("source archive refused"); });
        await expect(commitMemoryCompression(request, deps)).rejects.toThrow("source archive refused");
        expect(events).toEqual(["new-record", "new-vector", "synced", "archive", "deactivate", "restore", "remove:combined-vector", "remove-record"]);
    });
    it("keeps a completed commit successful if obsolete-vector cleanup fails", async () => {
        const { deps } = fixture();
        vi.mocked(deps.deleteVectors).mockRejectedValue(new Error("cleanup unavailable"));
        await expect(commitMemoryCompression(request, deps)).resolves.toEqual({ summaryId: "combined-memory", ragId: "combined-vector" });
        expect(deps.warn).toHaveBeenCalledWith("Failed to clean archived memory vectors", expect.any(Error));
    });
});
