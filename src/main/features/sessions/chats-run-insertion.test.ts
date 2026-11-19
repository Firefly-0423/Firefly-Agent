import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../../shared/ipc-channels";
import type { ChatMessage } from "../../../shared/chat-types";
const profile = vi.hoisted(() => ({ root: "", sessionId: "", blocked: "", handlers: new Map<string, any>() }));
vi.mock("electron", () => ({ app: { getPath: () => profile.root }, shell: { openPath: vi.fn() }, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: (channel: string, handler: any) => profile.handlers.set(channel, handler) }, dialog: { showOpenDialog: vi.fn() } }));
vi.mock("../../base/storage/storage-context", async original => ({
    ...await original<typeof import("../../base/storage/storage-context")>(),
    getStorageContext: () => ({ dataRoot: profile.root }),
}));
vi.mock("fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return { ...actual, writeFileSync: (file: any, ...args: any[]) => {
            if (profile.blocked && String(file).includes(profile.blocked))
                throw Object.assign(new Error("fixture storage failure"), { code: "EIO" });
            return (actual.writeFileSync as any)(file, ...args);
        } };
});
beforeEach(() => { profile.blocked = ""; vi.resetModules(); profile.handlers.clear(); profile.root = fs.mkdtempSync(join(tmpdir(), "run-insertion-")); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); fs.rmSync(profile.root, { recursive: true, force: true }); });
const entry = (id: string, patch: Record<string, unknown> = {}) => ({ id, rawContent: `Queued instruction ${id}`, visibleContent: `Queued instruction ${id}`, ...patch });
const existing: ChatMessage = { id: "existing", role: "user", content: "Existing conversation", at: 1 };
async function setup(queued: string[] = [], withHistory = true) {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work", initialMessages: withHistory ? [{ ...existing }] : [] });
    profile.sessionId = session.id;
    for (const id of queued)
        expect(store.enqueuePendingMessage(session.id, entry(id))).toMatchObject({ ok: true, enqueued: true });
    return { store, id: session.id };
}
function insert(store: typeof import("./chats-store"), sessionId: string, messageId: string, runId: string, options?: { assistantTurnId?: string }) {
    expect(store.markPendingAdjust(sessionId, messageId, runId)).toMatchObject({ ok: true });
    const result = store.commitPendingAdjust(sessionId, messageId, runId, options);
    if (!result.ok)
        throw new Error("commit failed: " + result.error);
    return result.userMessage;
}
const mark = (runId: string, sequence: number, assistantTurnId?: string) => ({ version: 1 as const, runId, revision: 1, sequence, ...(assistantTurnId ? { assistantTurnId } : {}) });
const inserted = (id: string, runInsertion: unknown): ChatMessage => ({ id, role: "user", content: `Queued instruction ${id}`, at: expect.any(Number) as unknown as number, runInsertion } as ChatMessage);
function failWrite() { profile.blocked = profile.sessionId; return { mockRestore: () => { profile.blocked = ""; } }; }
async function ipcSetup() {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();
    const store = await import("./chats-store");
    const call = (channel: string, payload: any) => profile.handlers.get(channel)({ sender: {} }, payload);
    return { store, call };
}
const forged = { version: 1, runId: "forged-run", revision: 9, sequence: 99, assistantTurnId: "forged-turn" };

it("projects saved delivery receipts into history only for the owning conversation, turn and revision", async () => {
    const { store, id } = await setup(["first", "second", "other", "wrong-version"]);
    const { call } = await ipcSetup();
    const runs = (await import("../../agent/loop/run-store")).getAgentRunStore(profile.root);
    const request = { mode: "work", provider: "mock", model: "mock", contextWindowTokens: 1024,
        promptFingerprint: "prompt", toolSchemaFingerprint: "tools" };
    runs.create({ conversationId: id, runId: "run-A", messages: [], request });
    runs.create({ conversationId: "another-session", runId: "run-B", messages: [], request });
    const answer = (runId: string): ChatMessage => ({ id: "answer-" + runId, role: "model", content: "", at: 2,
        runSnapshot: { status: "running", runId, updatedAt: 2 } });
    store.upsertMessage(id, answer("run-A"));
    store.upsertMessage(id, answer("run-B"));
    for (const key of ["first", "second", "wrong-version"]) insert(store, id, key, "run-A", { assistantTurnId: "answer-run-A" });
    insert(store, id, "other", "run-B", { assistantTurnId: "answer-run-B" });
    const markers = async () => {
        const session: import("../../../shared/chat-types").ChatSession = await call(IPC.CHATS_GET, id);
        return Object.fromEntries(session.messages.filter(message => message.runInsertion)
            .map(message => [message.id, message.runInsertion?.delivery]));
    };
    expect(await markers()).toEqual({ first: undefined, second: undefined, other: undefined, "wrong-version": undefined });
    runs.checkpoint("run-A", { insertions: [
        { messageId: "first", sourceRunId: "run-A", revision: 1, round: 3, order: 1 },
        { messageId: "wrong-version", sourceRunId: "run-A", revision: 2, round: 3, order: 2 },
    ] });
    runs.checkpoint("run-B", { insertions: [{ messageId: "other", sourceRunId: "run-B", revision: 1, round: 4, order: 1 }] });
    runs.markTerminal("run-A", "completed");
    expect(await markers()).toEqual({ first: { round: 3, order: 1 }, second: undefined, other: undefined, "wrong-version": undefined });
    expect(store.getSession(id)?.messages.find(message => message.id === "first")?.runInsertion).not.toHaveProperty("delivery");
    const read = runs.insertionEvidence.bind(runs);
    vi.spyOn(runs, "insertionEvidence").mockImplementation(runId => {
        if (runId === "run-B") throw new Error("AGENT_RUN_READ_FAILED");
        return read(runId);
    });
    expect(await markers()).toEqual({ first: { round: 3, order: 1 }, second: undefined, other: undefined, "wrong-version": undefined });
});

describe("run insertion marker (#96)", () => {
    describe("commitPendingAdjust marks the history message", () => {
        it("numbers insertions per run in commit order and stores the exact marked messages", async () => {
            const { store, id } = await setup(["a1", "a2", "b1"]);
            const first = insert(store, id, "a1", "run-A");
            const second = insert(store, id, "a2", "run-A", { assistantTurnId: "turn-7" });
            const other = insert(store, id, "b1", "run-B");
            expect(first).toEqual(inserted("a1", mark("run-A", 1)));
            expect(second).toEqual(inserted("a2", mark("run-A", 2, "turn-7")));
            expect(other).toEqual(inserted("b1", mark("run-B", 1)));
            expect(first).not.toHaveProperty("runInsertion.assistantTurnId");
            expect(other).not.toHaveProperty("runInsertion.assistantTurnId");
            expect(store.getSession(id)!.messages).toEqual([existing, first, second, other]);
            expect(store.listRunInsertions(id, "run-A")).toEqual([first, second]);
            expect(store.listRunInsertions(id, "run-B")).toEqual([other]);
            expect(store.listRunInsertions(id, "run-C")).toEqual([]);
            expect(store.getPendingMessages(id)).toEqual([]);
        });
        it("counts sequence per session so another session starts again at 1", async () => {
            const { store, id } = await setup(["a1"]);
            const second = store.createSession({ mode: "work" });
            profile.sessionId = second.id;
            expect(store.enqueuePendingMessage(second.id, entry("s2"))).toMatchObject({ ok: true });
            insert(store, id, "a1", "run-A");
            const other = insert(store, second.id, "s2", "run-A");
            expect(other.runInsertion).toEqual(mark("run-A", 1));
            expect(store.listRunInsertions(id, "run-A").map(m => m.id)).toEqual(["a1"]);
            expect(store.listRunInsertions(second.id, "run-A").map(m => m.id)).toEqual(["s2"]);
        });
        it("keeps the marker after the store is reloaded from disk", async () => {
            let { store, id } = await setup(["a1", "a2"]);
            const first = insert(store, id, "a1", "run-A", { assistantTurnId: "turn-1" });
            const second = insert(store, id, "a2", "run-A");
            vi.resetModules();
            store = await import("./chats-store");
            store.initialize();
            expect(store.listRunInsertions(id, "run-A")).toEqual([first, second]);
            expect(store.listRunInsertions(id, "run-A").map(m => m.runInsertion)).toEqual([mark("run-A", 1, "turn-1"), mark("run-A", 2)]);
        });
        it("returns an empty list for an unknown session", async () => {
            const { store } = await setup();
            expect(store.listRunInsertions("absent-session", "run-A")).toEqual([]);
        });
        it("leaves history, queue and marks unchanged after a write failure and does not consume a sequence", async () => {
            const { store, id } = await setup(["a1", "a2"]);
            expect(store.markPendingAdjust(id, "a1", "run-A")).toMatchObject({ ok: true });
            const queueBefore = store.getPendingMessages(id);
            const fault = failWrite();
            const failed = store.commitPendingAdjust(id, "a1", "run-A", { assistantTurnId: "turn-1" });
            fault.mockRestore();
            expect(failed).toEqual({ ok: false, error: "write-failed" });
            expect(store.getSession(id)!.messages).toEqual([existing]);
            expect(store.getPendingMessages(id)).toEqual(queueBefore);
            expect(store.getPendingMessages(id)![0].adjustRunId).toEqual("run-A");
            expect(store.listRunInsertions(id, "run-A")).toEqual([]);
            const retry = store.commitPendingAdjust(id, "a1", "run-A");
            expect(retry).toMatchObject({ ok: true, userMessage: { id: "a1", runInsertion: mark("run-A", 1) } });
        });
        it.each([
            ["run mismatch", "a1", "other-run", "run-mismatch"],
            ["unknown message", "ghost", "run-A", "not-found"],
        ])("keeps history and queue unchanged on %s", async (_name, messageId, runId, error) => {
            const { store, id } = await setup(["a1"]);
            expect(store.markPendingAdjust(id, "a1", "run-A")).toMatchObject({ ok: true });
            const queueBefore = store.getPendingMessages(id);
            expect(store.commitPendingAdjust(id, messageId, runId, { assistantTurnId: "turn-1" })).toEqual({ ok: false, error });
            expect(store.getSession(id)!.messages).toEqual([existing]);
            expect(store.getPendingMessages(id)).toEqual(queueBefore);
            expect(store.listRunInsertions(id, "run-A")).toEqual([]);
            expect(store.listRunInsertions(id, runId)).toEqual([]);
        });
    });
    describe("the marker is Main-owned at the IPC boundary", () => {
        it("strips a forged marker from append, upsert and replace-tail so the message is stored without it", async () => {
            const { store, call } = await ipcSetup();
            const session = await call(IPC.CHATS_CREATE, { mode: "work" });
            const forge = (id: string) => ({ id, role: "user", content: `Forged ${id}`, at: 10, runInsertion: forged }) as ChatMessage;
            const plain = (id: string) => ({ id, role: "user", content: `Forged ${id}`, at: 10 }) as ChatMessage;
            await call(IPC.CHATS_APPEND, { id: session.id, message: forge("via-append") });
            await call(IPC.CHATS_UPSERT, { id: session.id, message: forge("via-upsert") });
            await call(IPC.CHATS_REPLACE_TAIL, { id: session.id, startIndex: 2, messages: [forge("via-tail")] });
            expect(store.getSession(session.id)!.messages).toEqual([plain("via-append"), plain("via-upsert"), plain("via-tail")]);
            for (const message of store.getSession(session.id)!.messages)
                expect(message).not.toHaveProperty("runInsertion");
            expect(store.listRunInsertions(session.id, "forged-run")).toEqual([]);
        });
        it("keeps the stored marker when the renderer upserts or replaces the tail with the field absent or forged", async () => {
            const { store, call } = await ipcSetup();
            const session = await call(IPC.CHATS_CREATE, { mode: "work" });
            store.appendMessage(session.id, { ...existing });
            store.enqueuePendingMessage(session.id, entry("ins"));
            const stored = insert(store, session.id, "ins", "run-A", { assistantTurnId: "turn-1" });
            const expectedMark = mark("run-A", 1, "turn-1");
            expect(stored.runInsertion).toEqual(expectedMark);
            const oldCopy = { id: "ins", role: "user", content: "Edited text", at: stored.at } as ChatMessage;
            const forgedCopy = { ...oldCopy, runInsertion: forged } as ChatMessage;
            const history = () => store.getSession(session.id)!.messages;
            // 上方 append 的 "existing" 与会话初始消息无关，这里只关心 ins 的位置
            const position = () => history().findIndex(m => m.id === "ins");
            for (const [label, message] of [["absent", oldCopy], ["forged", forgedCopy]] as const) {
                await call(IPC.CHATS_UPSERT, { id: session.id, message });
                expect(history()[position()], "upsert " + label).toEqual({ ...oldCopy, runInsertion: expectedMark });
                await call(IPC.CHATS_REPLACE_TAIL, { id: session.id, startIndex: position(), messages: [message] });
                expect(history()[position()], "replace-tail " + label).toEqual({ ...oldCopy, runInsertion: expectedMark });
                expect(store.listRunInsertions(session.id, "run-A").map(m => m.runInsertion)).toEqual([expectedMark]);
                expect(store.listRunInsertions(session.id, "forged-run")).toEqual([]);
            }
        });
    });
    describe("store writes cannot erase or replace the marker", () => {
        it("keeps the stored marker on upsertMessage and replaceMessagesTail for a same-id message", async () => {
            const { store, id } = await setup(["ins"]);
            const stored = insert(store, id, "ins", "run-A", { assistantTurnId: "turn-1" });
            const expectedMark = mark("run-A", 1, "turn-1");
            const oldCopy = { id: "ins", role: "user", content: "Rewritten", at: stored.at } as ChatMessage;
            store.upsertMessage(id, oldCopy);
            expect(store.getSession(id)!.messages).toEqual([existing, { ...oldCopy, runInsertion: expectedMark }]);
            store.upsertMessage(id, { ...oldCopy, runInsertion: forged } as ChatMessage);
            expect(store.getSession(id)!.messages.at(-1)).toEqual({ ...oldCopy, runInsertion: expectedMark });
            store.replaceMessagesTail(id, 1, [oldCopy]);
            expect(store.getSession(id)!.messages).toEqual([existing, { ...oldCopy, runInsertion: expectedMark }]);
            store.replaceMessagesTail(id, 1, [{ ...oldCopy, runInsertion: forged } as ChatMessage]);
            expect(store.getSession(id)!.messages.at(-1)).toEqual({ ...oldCopy, runInsertion: expectedMark });
            expect(store.listRunInsertions(id, "run-A")).toEqual([{ ...oldCopy, runInsertion: expectedMark }]);
            expect(store.listRunInsertions(id, "forged-run")).toEqual([]);
        });
    });
    describe("history without markers", () => {
        it("returns no insertions and loads an older session file unchanged", async () => {
            let { store, id } = await setup([], false);
            const messages: ChatMessage[] = [existing, { id: "reply", role: "model", content: "Answer", at: 2 }, { id: "next", role: "user", content: "Follow up", at: 3 }];
            for (const message of messages)
                store.appendMessage(id, message);
            const file = join(store.getRootDir(), "sessions", id + ".json");
            const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
            expect(persisted.messages).toEqual(messages);
            vi.resetModules();
            store = await import("./chats-store");
            store.initialize();
            expect(store.getSession(id)!.messages).toEqual(messages);
            expect(store.listRunInsertions(id, "run-A")).toEqual([]);
            store.enqueuePendingMessage(id, entry("fresh"));
            expect(insert(store, id, "fresh", "run-A").runInsertion).toEqual(mark("run-A", 1));
            expect(store.listRunInsertions(id, "run-A").map(m => m.id)).toEqual(["fresh"]);
        });
    });
});
