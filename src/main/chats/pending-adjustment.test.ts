import { describe, expect, it, vi } from "vitest";
import type { PendingChatMessage, PendingChatAttachment } from "../../shared/chat-types";
vi.mock("electron", () => ({ app: { getPath: () => "" }, shell: { openPath: vi.fn() } }));
import { createRunAdjustmentPoller, bindRunAdjustmentPoller, requireRunAdjustmentPermit, type PendingAdjustmentStore, type TranscriptUserWritePort } from "./pending-adjustment";
const item = (id: string, run = "current-run", attachments?: PendingChatAttachment[]): PendingChatMessage => ({ id, rawContent: `Instruction ${id}`, visibleContent: `Instruction ${id}`, enqueuedAt: 8, ...(run ? { adjustRunId: run } : {}), ...(attachments ? { attachments } : {}) });
function environment(entries: PendingChatMessage[] = []) {
    let queue = entries;
    let transcriptFailure = false;
    let commitFailure = false;
    const sequence: string[] = [];
    const appendUser = vi.fn(async (input: any) => { sequence.push("trace:" + input.turnId); if (transcriptFailure)
        throw new Error("authoritative transcript unavailable"); });
    const commitPendingAdjust = vi.fn((session: string, id: string, run: string) => {
        sequence.push("history:" + id);
        if (commitFailure)
            return { ok: false as const, error: "write-failed" };
        queue = queue.filter(entry => entry.id !== id);
        return { ok: true as const, userMessage: { id }, remainingQueue: queue };
    });
    const store: PendingAdjustmentStore = { getPendingMessages: session => session === "chat-session" ? queue : null, commitPendingAdjust };
    const transcript: TranscriptUserWritePort = { appendUser };
    const poll = createRunAdjustmentPoller("chat-session", "current-run", store, transcript);
    return { poll, store, transcript, appendUser, commitPendingAdjust, sequence, queue: () => queue, failTranscript: (value: boolean) => { transcriptFailure = value; }, failCommit: (value: boolean) => { commitFailure = value; } };
}
const binding = { sessionId: "chat-session", runId: "current-run" };
describe("adjustment history and transcript commits", () => {
    it("returns synchronously when the session or current-run marks are absent", () => {
        const f = environment([item("ordinary", ""), item("different", "another-run")]);
        expect(f.poll()).toBeUndefined();
        expect(createRunAdjustmentPoller("missing-session", "current-run", f.store, f.transcript)()).toBeUndefined();
        expect(f.commitPendingAdjust).not.toHaveBeenCalled();
        expect(f.appendUser).not.toHaveBeenCalled();
    });
    it("alternates transcript then history in queue order including attachment metadata", async () => {
        const attachments = [{ kind: "document", name: "design.md", filePath: "E:\\fixtures\\design.md" }] as PendingChatAttachment[];
        const f = environment([item("alpha", "current-run", attachments), item("beta"), item("gamma")]);
        const pending = f.poll();
        expect(pending).toBeInstanceOf(Promise);
        expect(await pending).toEqual(["alpha", "beta", "gamma"].map(id => ({ id, rawContent: `Instruction ${id}` })));
        expect(f.sequence).toEqual(["trace:alpha", "history:alpha", "trace:beta", "history:beta", "trace:gamma", "history:gamma"]);
        expect(f.appendUser.mock.calls[0][0]).toMatchObject({ turnId: "alpha", text: "Instruction alpha", attachments });
        expect(f.appendUser.mock.calls[1][0]).toMatchObject({ turnId: "beta", text: "Instruction beta" });
        expect(f.queue()).toEqual([]);
        expect(f.poll()).toBeUndefined();
        expect(f.commitPendingAdjust).toHaveBeenCalledTimes(3);
        expect(f.appendUser).toHaveBeenCalledTimes(3);
    });
    it("consumes only marks belonging to the bound run", async () => {
        const f = environment([item("owned"), item("other", "other-run")]);
        expect((await f.poll())!.map(entry => entry.id)).toEqual(["owned"]);
        expect(f.queue().map(entry => entry.id)).toEqual(["other"]);
        expect(f.appendUser.mock.calls.map(([input]) => input.turnId)).toEqual(["owned"]);
    });
    it("retains pending data if the transcript fails and never attempts history", async () => {
        const f = environment([item("retained")]);
        f.failTranscript(true);
        await expect(f.poll()).rejects.toThrow("authoritative transcript unavailable");
        expect(f.commitPendingAdjust).not.toHaveBeenCalled();
        expect(f.queue().map(entry => entry.id)).toEqual(["retained"]);
    });
    it("retries a failed history commit using the same stable transcript turn ID", async () => {
        const f = environment([item("retryable")]);
        f.failCommit(true);
        await expect(f.poll()).rejects.toThrow();
        expect(f.commitPendingAdjust).toHaveBeenCalledTimes(1);
        expect(f.queue().map(entry => entry.id)).toEqual(["retryable"]);
        f.failCommit(false);
        expect((await f.poll())!.map(entry => entry.id)).toEqual(["retryable"]);
        expect(f.commitPendingAdjust).toHaveBeenCalledTimes(2);
        expect(f.queue()).toEqual([]);
        expect(f.appendUser.mock.calls.map(([input]) => input.turnId)).toEqual(["retryable", "retryable"]);
    });
    it("supports legacy history-only polling and never injects a successful item twice", async () => {
        const f = environment([item("legacy")]);
        const poll = createRunAdjustmentPoller("chat-session", "current-run", f.store);
        expect((await poll())!.map(entry => entry.id)).toEqual(["legacy"]);
        expect(f.commitPendingAdjust.mock.calls).toEqual([["chat-session", "legacy", "current-run"]]);
        expect(f.queue()).toEqual([]);
        expect(f.appendUser).not.toHaveBeenCalled();
        expect(poll()).toBeUndefined();
    });
});
describe("Main-owned adjustment authority", () => {
    it("rejects forged producers and forged tickets", () => {
        expect(() => bindRunAdjustmentPoller(() => undefined, binding, vi.fn())).toThrow("MEMORY_CONTEXT_ADJUSTMENT_DENIED");
        expect(() => requireRunAdjustmentPermit({}, binding)).toThrow("MEMORY_CONTEXT_ADJUSTMENT_DENIED");
    });
    it("binds unchanged queue bytes to one session, run and single-use commit", async () => {
        const f = environment([item("admitted")]);
        let ticket!: object;
        bindRunAdjustmentPoller(f.poll, binding, async (permit, commit) => {
            ticket = permit;
            expect(requireRunAdjustmentPermit(permit, binding)).toEqual({ turnId: "admitted", revision: 1, text: "Instruction admitted" });
            for (const changed of [{ ...binding, sessionId: "other-session" }, { ...binding, runId: "other-run" }])
                expect(() => requireRunAdjustmentPermit(permit, changed)).toThrow("MEMORY_CONTEXT_ADJUSTMENT_DENIED");
            expect(f.commitPendingAdjust).not.toHaveBeenCalled();
            const result = commit();
            expect(() => commit()).toThrow("MEMORY_CONTEXT_ADJUSTMENT_DENIED");
            return result;
        });
        expect(await f.poll()).toEqual([{ id: "admitted", rawContent: "Instruction admitted" }]);
        expect(f.appendUser).not.toHaveBeenCalled();
        expect(f.queue()).toEqual([]);
        expect(() => requireRunAdjustmentPermit(ticket, binding)).toThrow("MEMORY_CONTEXT_ADJUSTMENT_DENIED");
    });
    it("retains data on stale boundaries or failed commits and succeeds after retry", async () => {
        const f = environment([item("boundary-item")]);
        let stale = true;
        bindRunAdjustmentPoller(f.poll, binding, async (_permit, commit) => { if (stale)
            throw new Error("MEMORY_CONTEXT_TRANSCRIPT_STALE"); return commit(); });
        await expect(f.poll()).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_STALE");
        expect(f.queue()).toHaveLength(1);
        expect(f.commitPendingAdjust).not.toHaveBeenCalled();
        stale = false;
        f.failCommit(true);
        await expect(f.poll()).rejects.toThrow("PENDING_ADJUST_COMMIT_FAILED");
        expect(f.queue()).toHaveLength(1);
        f.failCommit(false);
        expect(await f.poll()).toHaveLength(1);
        expect(f.queue()).toEqual([]);
    });
    it("refuses content mutated after admission", async () => {
        const f = environment([item("mutating")]);
        bindRunAdjustmentPoller(f.poll, binding, async (_permit, commit) => { f.queue()[0].rawContent = "Modified after approval"; return commit(); });
        await expect(f.poll()).rejects.toThrow("MEMORY_CONTEXT_ADJUSTMENT_STALE");
        expect(f.queue()).toHaveLength(1);
        expect(f.commitPendingAdjust).not.toHaveBeenCalled();
    });
    it("serializes overlapping polls without admitting the same item twice", async () => {
        const f = environment([item("concurrent")]);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const admit = vi.fn(async (_permit, commit) => { await gate; return commit(); });
        bindRunAdjustmentPoller(f.poll, binding, admit);
        const first = f.poll(), second = f.poll();
        release();
        expect(await first).toHaveLength(1);
        expect(await second).toEqual([]);
        expect(admit).toHaveBeenCalledTimes(1);
        expect(f.commitPendingAdjust).toHaveBeenCalledTimes(1);
    });
    it("never falls back to legacy commits after its Main binding is released", async () => {
        const f = environment([item("released")]);
        bindRunAdjustmentPoller(f.poll, binding, async (_permit, commit) => commit())();
        await expect(f.poll()).rejects.toThrow("MEMORY_CONTEXT_ADJUSTMENT_DENIED");
        expect(f.queue()).toHaveLength(1);
        expect(f.commitPendingAdjust).not.toHaveBeenCalled();
        expect(f.appendUser).not.toHaveBeenCalled();
        expect(() => bindRunAdjustmentPoller(f.poll, binding, async (_permit, commit) => commit())).toThrow("MEMORY_CONTEXT_ADJUSTMENT_DENIED");
    });
});
