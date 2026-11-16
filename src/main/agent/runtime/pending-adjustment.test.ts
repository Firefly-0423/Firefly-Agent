import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, PendingChatMessage, PendingChatAttachment } from "../../../shared/chat-types";
const profile = vi.hoisted(() => ({ root: "", sessionId: "", blocked: "" }));
vi.mock("electron", () => ({ app: { getPath: () => profile.root }, shell: { openPath: vi.fn() }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return { ...actual, writeFileSync: (file: any, ...args: any[]) => {
            if (profile.blocked && String(file).includes(profile.blocked))
                throw Object.assign(new Error("fixture storage failure"), { code: "EIO" });
            return (actual.writeFileSync as any)(file, ...args);
        } };
});
import { createRunAdjustmentPoller, bindRunAdjustmentPoller, requireRunAdjustmentPermit, isRunAdjustmentInFlight, RunAdjustmentRetryableError, type PendingAdjustmentStore, type TranscriptUserWritePort } from "./pending-adjustment";
import { exactly } from "../../../shared/testing/error-code.test-support";
const item = (id: string, run = "current-run", attachments?: PendingChatAttachment[]): PendingChatMessage => ({ id, rawContent: `Instruction ${id}`, visibleContent: `Instruction ${id}`, enqueuedAt: 8, ...(run ? { adjustRunId: run } : {}), ...(attachments ? { attachments } : {}) });
function environment(entries: PendingChatMessage[] = []) {
    let queue = entries;
    let transcriptFailure = false;
    let commitFailure = false;
    const history: ChatMessage[] = [];
    const sequence: string[] = [];
    const appendUser = vi.fn(async (input: any) => { sequence.push("trace:" + input.turnId); if (transcriptFailure)
        throw new Error("authoritative transcript unavailable"); return { text: input.text as string }; });
    const commitPendingAdjust = vi.fn((session: string, id: string, run: string, _options?: { assistantTurnId?: string }) => {
        sequence.push("history:" + id);
        if (commitFailure)
            return { ok: false as const, error: "write-failed" };
        const queued = queue.find(entry => entry.id === id)!;
        queue = queue.filter(entry => entry.id !== id);
        const userMessage: ChatMessage = { id, role: "user", content: queued.rawContent, at: 9, runInsertion: { version: 1, runId: run, revision: 1, sequence: history.length + 1 } };
        history.push(userMessage);
        return { ok: true as const, userMessage, remainingQueue: queue };
    });
    const listRunInsertions = vi.fn((session: string, run: string) => session === "chat-session" ? history.filter(message => message.runInsertion?.runId === run) : []);
    const store: PendingAdjustmentStore = { getPendingMessages: session => session === "chat-session" ? queue : null, commitPendingAdjust, listRunInsertions };
    const transcript: TranscriptUserWritePort = { appendUser };
    const poll = createRunAdjustmentPoller("chat-session", "current-run", store, transcript);
    return { poll, store, transcript, appendUser, commitPendingAdjust, sequence, queue: () => queue, history: () => history, failTranscript: (value: boolean) => { transcriptFailure = value; }, failCommit: (value: boolean) => { commitFailure = value; } };
}
const binding = { sessionId: "chat-session", runId: "current-run" };
const delivered = (...ids: string[]) => ids.map(id => ({ id, rawContent: `Instruction ${id}`, revision: 1 }));
describe("adjustment history and transcript commits", () => {
    it("returns synchronously when the session or current-run marks are absent", () => {
        const f = environment([item("ordinary", ""), item("different", "another-run")]);
        expect(f.poll()).toBeUndefined();
        expect(createRunAdjustmentPoller("missing-session", "current-run", f.store, f.transcript)()).toBeUndefined();
        expect(f.commitPendingAdjust).not.toHaveBeenCalled();
        expect(f.appendUser).not.toHaveBeenCalled();
        expect(f.queue().map(entry => entry.id)).toEqual(["ordinary", "different"]);
    });
    it("commits history then the transcript for each marked item in queue order including attachment metadata", async () => {
        const attachments = [{ kind: "document", name: "design.md", filePath: "E:\\fixtures\\design.md" }] as PendingChatAttachment[];
        const f = environment([item("alpha", "current-run", attachments), item("beta"), item("gamma")]);
        const pending = f.poll();
        expect(pending).toBeInstanceOf(Promise);
        expect(await pending).toEqual({ delivered: delivered("alpha", "beta", "gamma") });
        expect(f.sequence).toEqual(["history:alpha", "trace:alpha", "history:beta", "trace:beta", "history:gamma", "trace:gamma"]);
        expect(f.appendUser.mock.calls.map(([input]) => input)).toEqual([
            { turnId: "alpha", text: "Instruction alpha", attachments },
            { turnId: "beta", text: "Instruction beta" },
            { turnId: "gamma", text: "Instruction gamma" },
        ]);
        expect(f.queue()).toEqual([]);
        expect(f.history().map(message => message.id)).toEqual(["alpha", "beta", "gamma"]);
        expect(f.poll()).toBeUndefined();
        expect(f.commitPendingAdjust).toHaveBeenCalledTimes(3);
        expect(f.appendUser).toHaveBeenCalledTimes(3);
    });
    it("consumes only marks belonging to the bound run", async () => {
        const f = environment([item("owned"), item("other", "other-run")]);
        expect(await f.poll()).toEqual({ delivered: delivered("owned") });
        expect(f.queue()).toEqual([item("other", "other-run")]);
        expect(f.appendUser.mock.calls.map(([input]) => input.turnId)).toEqual(["owned"]);
        expect(f.commitPendingAdjust.mock.calls.map(call => call[1])).toEqual(["owned"]);
        expect(f.history().map(message => message.id)).toEqual(["owned"]);
    });
    it("blocks as retryable when the transcript write fails after the history commit, then finishes it on the next pull without committing twice", async () => {
        const f = environment([item("retained")]);
        f.failTranscript(true);
        expect(await f.poll()).toEqual({ delivered: [], blocked: { messageId: "retained", reason: "transcript-write-failed", retryable: true } });
        expect(f.sequence).toEqual(["history:retained", "trace:retained"]);
        expect(f.queue()).toEqual([]);
        expect(f.history().map(message => message.id)).toEqual(["retained"]);
        f.failTranscript(false);
        expect(await f.poll()).toEqual({ delivered: delivered("retained") });
        expect(f.commitPendingAdjust).toHaveBeenCalledTimes(1);
        expect(f.appendUser.mock.calls.map(([input]) => input.turnId)).toEqual(["retained", "retained"]);
        expect(f.poll()).toBeUndefined();
    });
    it("blocks a failed history commit as retryable without writing the transcript, then delivers the same item once the fault clears", async () => {
        const f = environment([item("retryable")]);
        f.failCommit(true);
        expect(await f.poll()).toEqual({ delivered: [], blocked: { messageId: "retryable", reason: "write-failed", retryable: true } });
        expect(f.appendUser).not.toHaveBeenCalled();
        expect(f.commitPendingAdjust).toHaveBeenCalledTimes(1);
        expect(f.queue().map(entry => entry.id)).toEqual(["retryable"]);
        expect(f.history()).toEqual([]);
        f.failCommit(false);
        expect(await f.poll()).toEqual({ delivered: delivered("retryable") });
        expect(f.commitPendingAdjust).toHaveBeenCalledTimes(2);
        expect(f.queue()).toEqual([]);
        expect(f.appendUser.mock.calls.map(([input]) => input.turnId)).toEqual(["retryable"]);
    });
    it("supports legacy history-only polling, forwards commit options and never injects a successful item twice", async () => {
        const f = environment([item("legacy")]);
        const poll = createRunAdjustmentPoller("chat-session", "current-run", f.store, undefined, { assistantTurnId: "assistant-1" });
        expect(await poll()).toEqual({ delivered: delivered("legacy") });
        expect(f.commitPendingAdjust.mock.calls).toEqual([["chat-session", "legacy", "current-run", { assistantTurnId: "assistant-1" }]]);
        expect(f.queue()).toEqual([]);
        expect(f.appendUser).not.toHaveBeenCalled();
        expect(poll()).toBeUndefined();
        expect(f.commitPendingAdjust).toHaveBeenCalledTimes(1);
    });
});
describe("history-first commit and recovery (#96)", () => {
    const RUN = "run-96";
    beforeEach(() => { profile.blocked = ""; vi.resetModules(); profile.root = fs.mkdtempSync(join(tmpdir(), "run-insertion-")); });
    afterEach(() => { profile.blocked = ""; vi.restoreAllMocks(); fs.rmSync(profile.root, { recursive: true, force: true }); });
    async function arrange(ids = ["A", "B", "C"]) {
        const store = await import("../../features/sessions/chats-store");
        store.initialize();
        const session = store.createSession({ mode: "work", initialMessages: [{ id: "existing", role: "user", content: "Existing conversation", at: 1 }] });
        profile.sessionId = session.id;
        for (const id of ids)
            expect(store.enqueuePendingMessage(session.id, { id, rawContent: `Queued ${id}`, visibleContent: `Queued ${id}` })).toMatchObject({ ok: true, enqueued: true });
        for (const id of ids)
            expect(store.markPendingAdjust(session.id, id, RUN)).toMatchObject({ ok: true });
        const queue = () => store.getPendingMessages(session.id)!;
        const history = () => store.getSession(session.id)!.messages;
        const insertion = (id: string) => history().find(message => message.id === id)?.runInsertion;
        return { store, sessionId: session.id, queue, history, insertion };
    }
    /** In-memory transcript: the first write for a turn id wins, later writes read back the stored text. */
    function memoryTranscript(seed: Record<string, string> = {}) {
        const stored = new Map(Object.entries(seed));
        const failing = new Set<string>();
        const written: string[] = [];
        const hooks: { afterWrite?: (turnId: string) => void } = {};
        const appendUser = vi.fn(async (input: { turnId: string; text: string }) => {
            if (failing.has(input.turnId))
                throw new Error("transcript unavailable");
            if (!stored.has(input.turnId)) {
                stored.set(input.turnId, input.text);
                written.push(input.turnId);
            }
            hooks.afterWrite?.(input.turnId);
            return { text: stored.get(input.turnId)! };
        });
        const port: TranscriptUserWritePort = { appendUser };
        return { port, appendUser, written, failing, hooks };
    }
    const queued = (...ids: string[]) => ids.map(id => ({ id, rawContent: `Queued ${id}`, revision: 1 }));
    it("blocks at a failed history commit, keeps it and the later items marked in the queue, and delivers the rest in order once the fault clears", async () => {
        const f = await arrange();
        const transcript = memoryTranscript();
        transcript.hooks.afterWrite = turnId => { if (turnId === "A") profile.blocked = f.sessionId; };
        const poll = createRunAdjustmentPoller(f.sessionId, RUN, f.store, transcript.port);
        expect(await poll()).toEqual({ delivered: queued("A"), blocked: { messageId: "B", reason: "write-failed", retryable: true } });
        expect(f.queue().map(entry => [entry.id, entry.adjustRunId])).toEqual([["B", RUN], ["C", RUN]]);
        expect(f.history().map(message => message.id)).toEqual(["existing", "A"]);
        expect(transcript.written).toEqual(["A"]);
        expect(isRunAdjustmentInFlight(f.sessionId, "B")).toBe(false);
        profile.blocked = "";
        expect(await poll()).toEqual({ delivered: queued("B", "C") });
        expect(f.queue()).toEqual([]);
        expect(f.history().map(message => [message.id, message.runInsertion?.sequence])).toEqual([["existing", undefined], ["A", 1], ["B", 2], ["C", 3]]);
        expect(transcript.appendUser.mock.calls.map(([input]) => input.turnId)).toEqual(["A", "B", "C"]);
        expect(poll()).toBeUndefined();
    });
    it("blocks at a transcript write failure after the history commit, then the same poller finishes that item before the next one", async () => {
        const f = await arrange();
        const transcript = memoryTranscript();
        transcript.failing.add("B");
        const poll = createRunAdjustmentPoller(f.sessionId, RUN, f.store, transcript.port);
        expect(await poll()).toEqual({ delivered: queued("A"), blocked: { messageId: "B", reason: "transcript-write-failed", retryable: true } });
        expect(f.insertion("B")).toEqual({ version: 1, runId: RUN, revision: 1, sequence: 2 });
        expect(f.queue().map(entry => entry.id)).toEqual(["C"]);
        expect(transcript.written).toEqual(["A"]);
        transcript.failing.clear();
        expect(await poll()).toEqual({ delivered: queued("B", "C") });
        expect(transcript.written).toEqual(["A", "B", "C"]);
        expect(transcript.appendUser.mock.calls.map(([input]) => input.turnId)).toEqual(["A", "B", "B", "C"]);
        expect(f.history().filter(message => message.id === "B")).toHaveLength(1);
        expect(poll()).toBeUndefined();
    });
    it("lets a recreated poller for the same run recover the committed item before the still-queued one", async () => {
        const f = await arrange();
        const transcript = memoryTranscript();
        transcript.failing.add("B");
        const first = createRunAdjustmentPoller(f.sessionId, RUN, f.store, transcript.port);
        expect(await first()).toMatchObject({ delivered: queued("A"), blocked: { messageId: "B", retryable: true } });
        transcript.failing.clear();
        const recreated = createRunAdjustmentPoller(f.sessionId, RUN, f.store, transcript.port);
        // The new poller has handed nothing yet, so it also re-hands A (already in the transcript with the same text); the run loop's receipts absorb that repeat.
        expect(await recreated()).toEqual({ delivered: queued("A", "B", "C") });
        expect(transcript.written).toEqual(["A", "B", "C"]);
        expect(f.queue()).toEqual([]);
        expect(f.history().map(message => message.id)).toEqual(["existing", "A", "B", "C"]);
        expect(recreated()).toBeUndefined();
    });
    it("blocks an existing transcript entry with different text as a non-retryable conflict, delivers nothing after it and stays blocked", async () => {
        const f = await arrange();
        const transcript = memoryTranscript({ B: "Some other message" });
        const poll = createRunAdjustmentPoller(f.sessionId, RUN, f.store, transcript.port);
        const conflict = { delivered: queued("A"), blocked: { messageId: "B", reason: "transcript-conflict", retryable: false } };
        expect(await poll()).toEqual(conflict);
        expect(f.insertion("B")).toMatchObject({ runId: RUN, sequence: 2 });
        expect(f.queue().map(entry => [entry.id, entry.adjustRunId])).toEqual([["C", RUN]]);
        expect(transcript.written).toEqual(["A"]);
        expect(await poll()).toEqual({ delivered: [], blocked: conflict.blocked });
        expect(f.queue().map(entry => entry.id)).toEqual(["C"]);
        expect(transcript.written).toEqual(["A"]);
    });
    it("delivers an item whose existing transcript entry has the same text without rewriting it", async () => {
        const f = await arrange();
        const transcript = memoryTranscript({ B: "Queued B" });
        const poll = createRunAdjustmentPoller(f.sessionId, RUN, f.store, transcript.port);
        expect(await poll()).toEqual({ delivered: queued("A", "B", "C") });
        expect(transcript.written).toEqual(["A", "C"]);
        expect(f.queue()).toEqual([]);
    });
    it.each([
        ["run-mismatch", false],
        ["not-found", false],
        ["session-not-found", false],
        ["write-failed", true],
    ])("blocks a %s history commit result with retryable=%s and writes nothing to the transcript", async (error, retryable) => {
        const commitPendingAdjust = vi.fn(() => ({ ok: false as const, error }));
        const store: PendingAdjustmentStore = { getPendingMessages: () => [item("B", RUN), item("C", RUN)], commitPendingAdjust: commitPendingAdjust as any, listRunInsertions: () => [] };
        const transcript = memoryTranscript();
        const result = await createRunAdjustmentPoller("chat-session", RUN, store, transcript.port)();
        expect(result).toEqual({ delivered: [], blocked: { messageId: "B", reason: error, retryable } });
        expect(commitPendingAdjust).toHaveBeenCalledTimes(1);
        expect(transcript.appendUser).not.toHaveBeenCalled();
    });
    it.each([
        ["with the assistant turn id", { assistantTurnId: "assistant-turn-1" }, { version: 1, runId: RUN, assistantTurnId: "assistant-turn-1", revision: 1, sequence: 1 }],
        ["without options", undefined, { version: 1, runId: RUN, revision: 1, sequence: 1 }],
    ])("stores the run insertion marker %s", async (_name, options, expected) => {
        const f = await arrange(["A"]);
        const poll = createRunAdjustmentPoller(f.sessionId, RUN, f.store, memoryTranscript().port, options);
        expect(await poll()).toEqual({ delivered: queued("A") });
        expect(f.insertion("A")).toEqual(expected);
    });
    it("finishes a message committed earlier before newly marked items, even when the new item was queued first", async () => {
        const f = await arrange(["C", "B"]);
        expect(f.queue().map(entry => entry.id)).toEqual(["C", "B"]);
        // An earlier poller committed B to history, then lost its transcript write.
        expect(f.store.commitPendingAdjust(f.sessionId, "B", RUN)).toMatchObject({ ok: true });
        expect(f.queue().map(entry => entry.id)).toEqual(["C"]);
        const transcript = memoryTranscript();
        expect(await createRunAdjustmentPoller(f.sessionId, RUN, f.store, transcript.port)()).toEqual({ delivered: queued("B", "C") });
        expect(transcript.written).toEqual(["B", "C"]);
        expect(f.history().map(message => message.id)).toEqual(["existing", "B", "C"]);
    });
    it("answers a pull made while another is active with an empty result and hands nothing over twice", async () => {
        const f = await arrange(["A"]);
        const transcript = memoryTranscript();
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        transcript.appendUser.mockImplementationOnce(async input => { await gate; return { text: input.text }; });
        const poll = createRunAdjustmentPoller(f.sessionId, RUN, f.store, transcript.port);
        const first = poll(), second = poll();
        expect(isRunAdjustmentInFlight(f.sessionId, "A")).toBe(true);
        release();
        expect(await first).toEqual({ delivered: queued("A") });
        expect(await second).toEqual({ delivered: [] });
        expect(isRunAdjustmentInFlight(f.sessionId, "A")).toBe(false);
        expect(transcript.appendUser).toHaveBeenCalledTimes(1);
        expect(poll()).toBeUndefined();
    });
});
describe("Main-owned adjustment authority", () => {
    it("rejects forged producers and forged tickets", () => {
        expect(() => bindRunAdjustmentPoller(() => undefined, binding, vi.fn())).toThrow(exactly("MEMORY_CONTEXT_ADJUSTMENT_DENIED"));
        expect(() => requireRunAdjustmentPermit({}, binding)).toThrow(exactly("MEMORY_CONTEXT_ADJUSTMENT_DENIED"));
    });
    it("binds unchanged queue bytes to one session, run and single-use commit", async () => {
        const f = environment([item("admitted")]);
        let ticket!: object;
        bindRunAdjustmentPoller(f.poll, binding, async (permit, commit) => {
            ticket = permit;
            expect(requireRunAdjustmentPermit(permit, binding)).toEqual({ turnId: "admitted", revision: 1, text: "Instruction admitted", committed: false });
            for (const changed of [{ ...binding, sessionId: "other-session" }, { ...binding, runId: "other-run" }])
                expect(() => requireRunAdjustmentPermit(permit, changed)).toThrow(exactly("MEMORY_CONTEXT_ADJUSTMENT_DENIED"));
            expect(f.commitPendingAdjust).not.toHaveBeenCalled();
            const result = commit();
            expect(() => commit()).toThrow(exactly("MEMORY_CONTEXT_ADJUSTMENT_DENIED"));
            return result;
        });
        expect(await f.poll()).toEqual({ delivered: [{ id: "admitted", rawContent: "Instruction admitted", revision: 1 }] });
        expect(f.appendUser).not.toHaveBeenCalled();
        expect(f.queue()).toEqual([]);
        expect(() => requireRunAdjustmentPermit(ticket, binding)).toThrow(exactly("MEMORY_CONTEXT_ADJUSTMENT_DENIED"));
    });
    it("blocks a stale boundary as non-retryable and a failed history write as retryable, keeping the queue until a retry delivers", async () => {
        const f = environment([item("boundary-item")]);
        let stale = true;
        bindRunAdjustmentPoller(f.poll, binding, async (_permit, commit) => { if (stale)
            throw new Error("MEMORY_CONTEXT_TRANSCRIPT_STALE"); return commit(); });
        expect(await f.poll()).toEqual({ delivered: [], blocked: { messageId: "boundary-item", reason: "MEMORY_CONTEXT_TRANSCRIPT_STALE", retryable: false } });
        expect(f.queue()).toHaveLength(1);
        expect(f.commitPendingAdjust).not.toHaveBeenCalled();
        stale = false;
        f.failCommit(true);
        expect(await f.poll()).toEqual({ delivered: [], blocked: { messageId: "boundary-item", reason: "write-failed", retryable: true } });
        expect(f.queue()).toHaveLength(1);
        expect(f.history()).toEqual([]);
        f.failCommit(false);
        expect(await f.poll()).toEqual({ delivered: delivered("boundary-item") });
        expect(f.queue()).toEqual([]);
        expect(f.history().map(message => message.id)).toEqual(["boundary-item"]);
    });
    it("blocks a history commit rejected for a non-write reason as non-retryable with its stable code", async () => {
        const f = environment([item("gone")]);
        f.commitPendingAdjust.mockReturnValueOnce({ ok: false as const, error: "not-found" });
        bindRunAdjustmentPoller(f.poll, binding, async (_permit, commit) => commit());
        expect(await f.poll()).toEqual({ delivered: [], blocked: { messageId: "gone", reason: "PENDING_ADJUST_COMMIT_FAILED:gone:not-found", retryable: false } });
        expect(f.history()).toEqual([]);
        expect(f.appendUser).not.toHaveBeenCalled();
    });
    it("reports an unrecognised handler failure as ADJUSTMENT_FAILED without leaking its message", async () => {
        const f = environment([item("odd")]);
        bindRunAdjustmentPoller(f.poll, binding, async () => { throw new Error("disk path C:\secret\file failed"); });
        expect(await f.poll()).toEqual({ delivered: [], blocked: { messageId: "odd", reason: "ADJUSTMENT_FAILED", retryable: false } });
        expect(f.commitPendingAdjust).not.toHaveBeenCalled();
        expect(f.queue()).toHaveLength(1);
    });
    it("delivers the committed prefix and blocks the next item as non-retryable when the handler refuses it", async () => {
        const f = environment([item("A"), item("B"), item("C")]);
        bindRunAdjustmentPoller(f.poll, binding, async (permit, commit) => {
            if (requireRunAdjustmentPermit(permit, binding).turnId === "B")
                throw new Error("MEMORY_CONTEXT_ADJUSTMENT_STALE");
            return commit();
        });
        expect(await f.poll()).toEqual({ delivered: delivered("A"), blocked: { messageId: "B", reason: "MEMORY_CONTEXT_ADJUSTMENT_STALE", retryable: false } });
        expect(f.history().map(message => message.id)).toEqual(["A"]);
        expect(f.queue().map(entry => entry.id)).toEqual(["B", "C"]);
        expect(f.commitPendingAdjust.mock.calls.map(call => call[1])).toEqual(["A"]);
    });
    it("recovers a committed item through a committed permit, calling the handler once and never committing history again", async () => {
        const f = environment([item("A")]);
        let fail = true;
        const seen: boolean[] = [];
        bindRunAdjustmentPoller(f.poll, binding, async (permit, commit) => {
            const allowed = requireRunAdjustmentPermit(permit, binding);
            seen.push(allowed.committed);
            const message = commit();
            if (fail) { fail = false; throw new RunAdjustmentRetryableError("transcript-write-failed"); }
            return message;
        });
        expect(await f.poll()).toEqual({ delivered: [], blocked: { messageId: "A", reason: "transcript-write-failed", retryable: true } });
        expect(f.history().map(message => message.id)).toEqual(["A"]);
        expect(await f.poll()).toEqual({ delivered: delivered("A") });
        expect(seen).toEqual([false, true]);
        expect(f.commitPendingAdjust).toHaveBeenCalledTimes(1);
        expect(f.poll()).toBeUndefined();
    });
    it("switches a permit to committed after its history commit and rejects it as stale once that history message is gone", async () => {
        const f = environment([item("A")]);
        const phases: boolean[] = [];
        bindRunAdjustmentPoller(f.poll, binding, async (permit, commit) => {
            phases.push(requireRunAdjustmentPermit(permit, binding).committed);
            commit();
            phases.push(requireRunAdjustmentPermit(permit, binding).committed);
            f.history().length = 0;
            expect(() => requireRunAdjustmentPermit(permit, binding)).toThrow(exactly("MEMORY_CONTEXT_ADJUSTMENT_STALE"));
            throw new Error("MEMORY_CONTEXT_ADJUSTMENT_STALE");
        });
        expect(await f.poll()).toEqual({ delivered: [], blocked: { messageId: "A", reason: "MEMORY_CONTEXT_ADJUSTMENT_STALE", retryable: false } });
        expect(phases).toEqual([false, true]);
        expect(f.appendUser).not.toHaveBeenCalled();
    });
    it("refuses content mutated after admission", async () => {
        const f = environment([item("mutating")]);
        bindRunAdjustmentPoller(f.poll, binding, async (_permit, commit) => { f.queue()[0].rawContent = "Modified after approval"; return commit(); });
        expect(await f.poll()).toEqual({ delivered: [], blocked: { messageId: "mutating", reason: "MEMORY_CONTEXT_ADJUSTMENT_STALE", retryable: false } });
        expect(f.queue()).toHaveLength(1);
        expect(f.commitPendingAdjust).not.toHaveBeenCalled();
    });
    it("blocks a later item unmarked while an earlier one is admitted, delivering only the earlier one and never calling the handler for it", async () => {
        const f = environment([item("first"), item("second")]);
        const admit = vi.fn(async (_permit, commit) => { const message = commit(); delete f.queue()[0].adjustRunId; return message; });
        bindRunAdjustmentPoller(f.poll, binding, admit);
        expect(await f.poll()).toEqual({
            delivered: [{ id: "first", rawContent: "Instruction first", revision: 1 }],
            blocked: { messageId: "second", reason: "MEMORY_CONTEXT_ADJUSTMENT_STALE", retryable: false },
        });
        expect(admit).toHaveBeenCalledTimes(1);
        expect(f.commitPendingAdjust).toHaveBeenCalledTimes(1);
        expect(f.queue().map(entry => entry.id)).toEqual(["second"]);
    });
    it("serializes overlapping polls without admitting the same item twice", async () => {
        const f = environment([item("concurrent")]);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const admit = vi.fn(async (_permit, commit) => { await gate; return commit(); });
        bindRunAdjustmentPoller(f.poll, binding, admit);
        const first = f.poll(), second = f.poll();
        release();
        expect((await first)!.delivered).toHaveLength(1);
        expect(await second).toEqual({ delivered: [] });
        expect(admit).toHaveBeenCalledTimes(1);
        expect(f.commitPendingAdjust).toHaveBeenCalledTimes(1);
    });
    it("never falls back to legacy commits after its Main binding is released", async () => {
        const f = environment([item("released")]);
        bindRunAdjustmentPoller(f.poll, binding, async (_permit, commit) => commit())();
        await expect(f.poll()).rejects.toThrow(exactly("MEMORY_CONTEXT_ADJUSTMENT_DENIED"));
        expect(f.queue()).toHaveLength(1);
        expect(f.commitPendingAdjust).not.toHaveBeenCalled();
        expect(f.appendUser).not.toHaveBeenCalled();
        expect(() => bindRunAdjustmentPoller(f.poll, binding, async (_permit, commit) => commit())).toThrow(exactly("MEMORY_CONTEXT_ADJUSTMENT_DENIED"));
    });
});
