import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
const profile = vi.hoisted(() => ({ root: "", sessionId: "", blocked: "", handlers: new Map<string, any>() }));
vi.mock("electron", () => ({ app: { getPath: () => profile.root }, shell: { openPath: vi.fn() }, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: (channel: string, handler: any) => profile.handlers.set(channel, handler) }, dialog: { showOpenDialog: vi.fn() } }));
vi.mock("fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return { ...actual, writeFileSync: (file: any, ...args: any[]) => {
            if (profile.blocked && String(file).includes(profile.blocked))
                throw Object.assign(new Error("fixture storage failure"), { code: "EIO" });
            return (actual.writeFileSync as any)(file, ...args);
        } };
});
beforeEach(() => { profile.blocked = ""; vi.resetModules(); profile.handlers.clear(); profile.root = fs.mkdtempSync(join(tmpdir(), "pending-contract-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(profile.root, { recursive: true, force: true }); });
const entry = (id: string, patch: Record<string, unknown> = {}) => ({ id, rawContent: `Queued instruction ${id}`, visibleContent: `Queued instruction ${id}`, ...patch });
async function setup(ids = ["alpha", "beta", "gamma"], withHistory = true) {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work", initialMessages: withHistory ? [{ id: "existing", role: "user", content: "Existing conversation", at: 1 }] : [] });
    for (const id of ids)
        expect(store.enqueuePendingMessage(session.id, entry(id))).toMatchObject({ ok: true, enqueued: true });
    profile.sessionId = session.id;
    return { store, id: session.id };
}
const ids = (queue: any) => queue?.map((item: any) => item.id);
function failWrite() { profile.blocked = profile.sessionId; return { mockRestore: () => { profile.blocked = ""; } }; }
const image = { kind: "image" as const, name: "annotated-map.png", filePath: "E:/fixtures/map.png", mime: "image/png", hasAnnotations: true };
const document = { kind: "document" as const, name: "itinerary.md", filePath: "E:/fixtures/itinerary.md" };
describe("pending data persistence", () => {
    it("recovers ordered entries, attachment references and the original enqueue timestamp after restart", async () => {
        let { store, id } = await setup([], false);
        const payload = entry("recover", { attachments: [image, document] });
        expect(store.enqueuePendingMessage(id, payload)).toMatchObject({ ok: true, enqueued: true });
        const first = store.getPendingMessages(id)![0];
        expect(typeof first.enqueuedAt).toEqual("number");
        store.enqueuePendingMessage(id, entry("later"));
        vi.resetModules();
        store = await import("./chats-store");
        store.initialize();
        expect(ids(store.getPendingMessages(id))).toEqual(["recover", "later"]);
        expect(store.getPendingMessages(id)![0]).toEqual(first);
        expect(store.getPendingMessages(id)![0].rawContent).toEqual("Queued instruction recover");
        expect(store.getPendingMessages(id)![0].attachments).toEqual([image, document]);
    });
    it("absorbs a repeated payload including attachments without changing its time or duplicating on disk", async () => {
        let { store, id } = await setup([], false);
        const payload = entry("stable-id", { attachments: [image] });
        const first = store.enqueuePendingMessage(id, payload);
        expect(first).toMatchObject({ ok: true, enqueued: true });
        const at = first.ok ? first.queue[0].enqueuedAt : 0;
        const retry = store.enqueuePendingMessage(id, payload);
        expect(retry).toMatchObject({ ok: true, enqueued: false });
        expect(retry.ok && retry.queue).toHaveLength(1);
        expect(retry.ok && retry.queue[0].enqueuedAt).toEqual(at);
        vi.resetModules();
        store = await import("./chats-store");
        store.initialize();
        expect(ids(store.getPendingMessages(id))).toEqual(["stable-id"]);
    });
    it("rejects conflicting bytes or attachments under the same ID", async () => {
        const { store, id } = await setup(["unique"]);
        for (const patch of [{ rawContent: "Changed instruction", visibleContent: "Changed instruction" }, { attachments: [document] }])
            expect(store.enqueuePendingMessage(id, entry("unique", patch))).toEqual({ ok: false, error: "duplicate-id" });
        expect(store.getPendingMessages(id)).toHaveLength(1);
        expect(store.getPendingMessages(id)![0].rawContent).toEqual("Queued instruction unique");
    });
    it("isolates queues across sessions and excludes pending entries from history and counts", async () => {
        const { store, id } = await setup(["alpha", "beta"]);
        const second = store.createSession({ mode: "chat" });
        store.enqueuePendingMessage(second.id, entry("other-session"));
        expect(ids(store.getPendingMessages(id))).toEqual(["alpha", "beta"]);
        expect(ids(store.getPendingMessages(second.id))).toEqual(["other-session"]);
        expect(ids(store.getSession(id)?.messages)).toEqual(["existing"]);
        expect(ids(store.getSession(id)?.pendingMessages)).toEqual(["alpha", "beta"]);
        expect(store.listSessions().find(item => item.id === id)?.messageCount).toEqual(1);
        store.removePendingMessage(id, "alpha");
        store.removePendingMessage(id, "beta");
        expect(store.getPendingMessages(id)).toEqual([]);
        expect(store.getPendingMessages(second.id)).toHaveLength(1);
    });
    it("rejects invalid enqueue input and leaves the queue empty on a failed write", async () => {
        const { store, id } = await setup([]);
        expect(store.enqueuePendingMessage("absent-session", entry("x"))).toEqual({ ok: false, error: "session-not-found" });
        expect(store.enqueuePendingMessage(id, entry("x", { rawContent: "   ", visibleContent: "" }))).toEqual({ ok: false, error: "empty-content" });
        expect(store.enqueuePendingMessage(id, entry("x", { attachments: [{ kind: "image", name: "missing-path" }] }) as any)).toEqual({ ok: false, error: "invalid-attachments" });
        expect(store.getPendingMessages(id)).toEqual([]);
        const fault = failWrite();
        expect(store.enqueuePendingMessage(id, entry("unwritten"))).toEqual({ ok: false, error: "write-failed" });
        fault.mockRestore();
        expect(store.getPendingMessages(id)).toEqual([]);
    });
    it("interprets an older session without the optional queue field as empty", async () => {
        let { store, id } = await setup([]);
        const persisted = store.getSession(id)!;
        delete persisted.pendingMessages;
        fs.writeFileSync(join(store.getRootDir(), "sessions", id + ".json"), JSON.stringify(persisted));
        vi.resetModules();
        store = await import("./chats-store");
        store.initialize();
        expect(store.getPendingMessages(id)).toEqual([]);
        expect(store.enqueuePendingMessage(id, entry("first-pending"))).toMatchObject({ ok: true });
        expect(ids(store.getPendingMessages(id))).toEqual(["first-pending"]);
    });
    it("keeps only stable attachment fields and stores sticker text separately", async () => {
        const { store, id } = await setup([]);
        const rawContent = "A route request [sticker:smile]";
        const result = store.enqueuePendingMessage(id, entry("decorated", { rawContent, visibleContent: "A route request", userSticker: "smile", attachments: [{ ...image, previewUrl: "blob:discard-me", status: "ready", imageSendMode: "caption" }, document] }) as any);
        expect(result).toMatchObject({ ok: true });
        expect(store.getPendingMessages(id)![0]).toMatchObject({ rawContent, visibleContent: "A route request", userSticker: "smile" });
        expect(store.getPendingMessages(id)![0].attachments).toEqual([image, document]);
    });
    it("removes IDs idempotently, reports missing sessions and retains data after failed deletion", async () => {
        const { store, id } = await setup(["removable"]);
        const fault = failWrite();
        expect(store.removePendingMessage(id, "removable")).toEqual({ ok: false, error: "write-failed" });
        fault.mockRestore();
        expect(ids(store.getPendingMessages(id))).toEqual(["removable"]);
        expect(store.removePendingMessage(id, "removable")).toEqual({ ok: true, removed: true });
        expect(store.getPendingMessages(id)).toEqual([]);
        for (const missing of ["removable", "never-queued"])
            expect(store.removePendingMessage(id, missing)).toEqual({ ok: true, removed: false });
        expect(store.removePendingMessage("absent-session", "removable")).toEqual({ ok: false, error: "session-not-found" });
        expect(store.getPendingMessages("absent-session")).toBeNull();
    });
    it("does not refresh recency or index bytes for ordinary queue changes", async () => {
        const { store, id } = await setup([]);
        const file = join(store.getRootDir(), "index.json"), before = fs.readFileSync(file, "utf8"), at = store.getSession(id)!.updatedAt;
        store.enqueuePendingMessage(id, entry("recency"));
        expect(store.getSession(id)!.updatedAt).toEqual(at);
        expect(fs.readFileSync(file, "utf8")).toEqual(before);
        store.removePendingMessage(id, "recency");
        expect(store.getSession(id)!.updatedAt).toEqual(at);
        expect(fs.readFileSync(file, "utf8")).toEqual(before);
        expect(store.listSessions().find(item => item.id === id)!.updatedAt).toEqual(at);
    });
});
describe("atomic claim and dispatch bookkeeping", () => {
    it("claims FIFO and requires dispatch acknowledgement before taking the next item", async () => {
        const { store, id } = await setup();
        for (const [n, expected] of ["alpha", "beta", "gamma"].entries()) {
            const claim = store.claimPendingMessage(id);
            expect(claim).toMatchObject({ ok: true, claimed: true });
            if (!claim.ok || !claim.claimed)
                throw new Error("claim was not accepted");
            expect(claim.userMessage).toMatchObject({ id: expected, role: "user" });
            expect(claim.session.messages.at(-1)?.id).toEqual(expected);
            expect(ids(claim.remainingQueue)).toEqual(["alpha", "beta", "gamma"].slice(n + 1));
            expect(store.getSession(id)?.pendingDispatch).toEqual({ messageId: expected, claimedAt: claim.userMessage.at });
            expect(store.claimPendingMessage(id)).toEqual({ ok: false, error: "already-dispatching" });
            expect(ids(store.getSession(id)?.messages)).toEqual(["existing", ...["alpha", "beta", "gamma"].slice(0, n + 1)]);
            expect(store.completePendingDispatch(id, "wrong-id")).toEqual({ ok: true, cleared: false });
            expect(store.getSession(id)?.pendingDispatch?.messageId).toEqual(expected);
            expect(store.completePendingDispatch(id, expected)).toEqual({ ok: true, cleared: true });
        }
        expect(store.getPendingMessages(id)).toEqual([]);
        expect(ids(store.getSession(id)?.messages)).toEqual(["existing", "alpha", "beta", "gamma"]);
        expect(store.getSession(id)?.pendingDispatch).toBeUndefined();
        expect(store.claimPendingMessage(id)).toEqual({ ok: true, claimed: false });
        expect(store.completePendingDispatch("missing-session", "alpha")).toEqual({ ok: false, error: "session-not-found" });
    });
    it("maps stable image and document attachments to pending message attachments and carries resume IDs", async () => {
        const { store, id } = await setup([], false);
        store.enqueuePendingMessage(id, entry("attached", { rawContent: "Review the map", visibleContent: "Review the map", attachments: [image, document], resumeFromRunId: "interrupted-run" }));
        const claim = store.claimPendingMessage(id);
        expect(claim).toMatchObject({ ok: true, claimed: true, visibleContent: "Review the map", resumeFromRunId: "interrupted-run" });
        if (!claim.ok || !claim.claimed)
            throw new Error("claim failed");
        expect(claim.userMessage.attachments).toEqual([{ ...image, status: "pending" }, { ...document, status: "pending" }]);
        expect(store.getSession(id)?.title).toEqual("Review the map");
    });
    it("leaves queue and history unchanged after a session write failure", async () => {
        const { store, id } = await setup();
        const fault = failWrite();
        expect(store.claimPendingMessage(id)).toEqual({ ok: false, error: "write-failed" });
        fault.mockRestore();
        expect(ids(store.getSession(id)?.messages)).toEqual(["existing"]);
        expect(ids(store.getPendingMessages(id))).toEqual(["alpha", "beta", "gamma"]);
        expect(store.getSession(id)?.pendingDispatch).toBeUndefined();
    });
    it("keeps an authoritative claim when only the index update fails", async () => {
        const { store, id } = await setup();
        profile.blocked = "index.json";
        const fault = { mockRestore: () => { profile.blocked = ""; } };
        const claim = store.claimPendingMessage(id);
        fault.mockRestore();
        expect(claim).toMatchObject({ ok: true, claimed: true, userMessage: { id: "alpha" } });
        expect(ids(store.getSession(id)?.messages)).toEqual(["existing", "alpha"]);
        expect(store.getSession(id)?.pendingDispatch).toEqual({ messageId: "alpha", claimedAt: expect.any(Number) });
        expect(ids(store.getPendingMessages(id))).toEqual(["beta", "gamma"]);
        expect(store.completePendingDispatch(id, "alpha")).toEqual({ ok: true, cleared: true });
    });
    it("keeps a claimed message when a late withdrawal arrives and restores incomplete dispatch after restart", async () => {
        let { store, id } = await setup(["claimed"]);
        const before = store.getSession(id)!.updatedAt;
        expect(store.claimPendingMessage(id)).toMatchObject({ ok: true, claimed: true });
        expect(store.removePendingMessage(id, "claimed")).toEqual({ ok: true, removed: false });
        expect(ids(store.getSession(id)?.messages)).toEqual(["existing", "claimed"]);
        expect(store.getPendingMessages(id)).toEqual([]);
        expect(store.getSession(id)!.updatedAt).toBeGreaterThanOrEqual(before);
        expect(store.listSessions().find(item => item.id === id)!.messageCount).toEqual(2);
        vi.resetModules();
        store = await import("./chats-store");
        store.initialize();
        expect(ids(store.getSession(id)?.messages)).toEqual(["existing", "claimed"]);
        expect(store.getSession(id)?.pendingDispatch).toEqual({ messageId: "claimed", claimedAt: expect.any(Number) });
        expect(store.getSession(id)?.pendingMessages ?? []).toEqual([]);
        expect(store.completePendingDispatch(id, "claimed")).toEqual({ ok: true, cleared: true });
        expect(store.completePendingDispatch(id, "claimed")).toEqual({ ok: true, cleared: false });
    });
});
describe("pending edits and run adjustments", () => {
    it("edits text without changing IDs, timestamps, ordering, attachments or history counts", async () => {
        const { store, id } = await setup(["alpha", "beta"]);
        const at = store.getPendingMessages(id)![0].enqueuedAt;
        store.enqueuePendingMessage(id, entry("attached", { attachments: [document] }));
        const result = store.editPendingMessage(id, "alpha", { rawContent: "Revised request [sticker:smile]", visibleContent: "Revised request", userSticker: "smile" });
        expect(result).toMatchObject({ ok: true });
        if (!result.ok)
            throw new Error("edit failed");
        expect(ids(result.queue)).toEqual(["alpha", "beta", "attached"]);
        expect(result.queue[0]).toMatchObject({ rawContent: "Revised request [sticker:smile]", visibleContent: "Revised request", userSticker: "smile", enqueuedAt: at });
        expect(result.queue[2].attachments).toEqual([document]);
        expect(ids(store.getSession(id)?.messages)).toEqual(["existing"]);
        expect(store.listSessions().find(item => item.id === id)!.messageCount).toEqual(1);
        expect(store.editPendingMessage(id, "alpha", { rawContent: "Plain replacement", visibleContent: "Plain replacement" }).ok).toEqual(true);
        expect(store.getPendingMessages(id)![0]).not.toHaveProperty("userSticker");
        expect(store.getPendingMessages(id)![0].rawContent).toEqual("Plain replacement");
    });
    it("rejects blank, absent and already-claimed edit targets with authoritative queue data", async () => {
        const { store, id } = await setup(["alpha", "beta"]);
        expect(store.editPendingMessage(id, "alpha", { rawContent: "  ", visibleContent: "" })).toMatchObject({ ok: false, error: "empty-content" });
        expect(store.getPendingMessages(id)![0].rawContent).toEqual("Queued instruction alpha");
        expect(store.editPendingMessage(id, "unknown", { rawContent: "Edit", visibleContent: "Edit" })).toMatchObject({ ok: false, error: "not-found" });
        expect(store.editPendingMessage("missing-session", "alpha", { rawContent: "Edit", visibleContent: "Edit" })).toEqual({ ok: false, error: "session-not-found" });
        expect(store.claimPendingMessage(id)).toMatchObject({ ok: true, claimed: true });
        expect(store.editPendingMessage(id, "alpha", { rawContent: "Late edit", visibleContent: "Late edit" })).toMatchObject({ ok: false, error: "already-claimed", queue: [expect.objectContaining({ id: "beta" })] });
        expect(store.getSession(id)?.messages.at(-1)?.content).toEqual("Queued instruction alpha");
        expect(store.editPendingMessage(id, "beta", { rawContent: "Still editable", visibleContent: "Still editable" }).ok).toEqual(true);
        expect(store.markPendingAdjust(id, "alpha", "running")).toMatchObject({ ok: false, error: "already-claimed" });
    });
    it("returns pre-write queue bytes if editing cannot be persisted", async () => {
        const { store, id } = await setup(["alpha", "beta"]);
        const fault = failWrite();
        const result = store.editPendingMessage(id, "alpha", { rawContent: "Unwritten edit", visibleContent: "Unwritten edit" });
        fault.mockRestore();
        expect(result).toMatchObject({ ok: false, error: "write-failed" });
        if (!result.ok)
            expect(result.queue?.[0].rawContent).toEqual("Queued instruction alpha");
        expect(store.getPendingMessages(id)![0].rawContent).toEqual("Queued instruction alpha");
    });
    it("binds marks to a run, absorbs same-run retries and rejects other runs and attachments", async () => {
        const { store, id } = await setup(["alpha", "beta"]);
        expect(store.markPendingAdjust(id, "alpha", "running")).toMatchObject({ ok: true });
        expect(store.getPendingMessages(id)![0]).toMatchObject({ id: "alpha", adjustRunId: "running" });
        expect(store.markPendingAdjust(id, "alpha", "running")).toMatchObject({ ok: true });
        expect(store.markPendingAdjust(id, "alpha", "another-run")).toMatchObject({ ok: false, error: "already-adjusting" });
        expect(store.getPendingMessages(id)![0].adjustRunId).toEqual("running");
        expect(store.markPendingAdjust(id, "unknown", "running")).toMatchObject({ ok: false, error: "not-found" });
        expect(store.markPendingAdjust("missing-session", "alpha", "running")).toEqual({ ok: false, error: "session-not-found" });
        store.enqueuePendingMessage(id, entry("attached", { attachments: [image] }));
        expect(store.markPendingAdjust(id, "attached", "running")).toMatchObject({ ok: false, error: "has-attachments" });
        const attached = store.getPendingMessages(id)![2];
        expect(attached).not.toHaveProperty("adjustRunId");
        expect(attached.attachments).toHaveLength(1);
        expect(store.editPendingMessage(id, "alpha", { rawContent: "Forbidden edit", visibleContent: "Forbidden edit" })).toMatchObject({ ok: false, error: "already-adjusting" });
        expect(store.getPendingMessages(id)![0].rawContent).toEqual("Queued instruction alpha");
        expect(store.removePendingMessage(id, "alpha")).toMatchObject({ ok: false, error: "already-adjusting", queue: [expect.objectContaining({ id: "alpha" }), expect.objectContaining({ id: "beta" }), expect.objectContaining({ id: "attached" })] });
        expect(store.getPendingMessages(id)![0]).toMatchObject({ id: "alpha", adjustRunId: "running" });
        store.resetPendingAdjustByRun(id, "running");
        expect(store.removePendingMessage(id, "alpha")).toEqual({ ok: true, removed: true });
        expect(ids(store.getPendingMessages(id))).toEqual(["beta", "attached"]);
    });
    it("commits a marked sticker message once without creating dispatch bookkeeping", async () => {
        const { store, id } = await setup([]);
        store.enqueuePendingMessage(id, entry("adjusted", { rawContent: "Try another route [sticker:smile]", visibleContent: "Try another route", userSticker: "smile" }));
        store.enqueuePendingMessage(id, entry("later"));
        store.markPendingAdjust(id, "adjusted", "running");
        expect(store.commitPendingAdjust(id, "adjusted", "wrong-run")).toMatchObject({ ok: false, error: "run-mismatch" });
        const result = store.commitPendingAdjust(id, "adjusted", "running");
        expect(result).toMatchObject({ ok: true });
        if (!result.ok)
            throw new Error("adjustment failed");
        expect(result.userMessage).toMatchObject({ id: "adjusted", role: "user", content: "Try another route [sticker:smile]", sticker: "smile" });
        expect(ids(result.remainingQueue)).toEqual(["later"]);
        expect(ids(store.getSession(id)?.messages)).toEqual(["existing", "adjusted"]);
        expect(ids(store.getPendingMessages(id))).toEqual(["later"]);
        expect(store.getSession(id)?.pendingDispatch).toBeUndefined();
        expect(store.listSessions().find(item => item.id === id)!.messageCount).toEqual(2);
        expect(store.commitPendingAdjust(id, "adjusted", "running")).toMatchObject({ ok: false, error: "not-found" });
        expect(store.getSession(id)?.messages.filter(item => item.id === "adjusted")).toHaveLength(1);
    });
    it("retains the run mark and original history if committing fails", async () => {
        const { store, id } = await setup(["alpha", "beta"]);
        store.markPendingAdjust(id, "alpha", "running");
        const fault = failWrite();
        expect(store.commitPendingAdjust(id, "alpha", "running")).toEqual({ ok: false, error: "write-failed" });
        fault.mockRestore();
        expect(ids(store.getSession(id)?.messages)).toEqual(["existing"]);
        expect(store.getSession(id)?.pendingMessages?.[0]).toMatchObject({ id: "alpha", adjustRunId: "running" });
    });
    it("preserves the marked item against withdrawal while its transcript write is pending", async () => {
        const { store, id } = await setup(["alpha", "beta"]);
        store.markPendingAdjust(id, "alpha", "running");
        const { createRunAdjustmentPoller } = await import("./pending-adjustment");
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const recorded: string[] = [];
        const poll = createRunAdjustmentPoller(id, "running", store, { appendUser: async (input) => { recorded.push(input.turnId); await gate; } });
        const processing = poll();
        expect(processing).toBeInstanceOf(Promise);
        expect(store.removePendingMessage(id, "alpha")).toMatchObject({ ok: false, error: "already-adjusting" });
        expect(store.getPendingMessages(id)![0].id).toEqual("alpha");
        release();
        expect(ids(await processing)).toEqual(["alpha"]);
        expect(recorded).toEqual(["alpha"]);
        expect(ids(store.getPendingMessages(id))).toEqual(["beta"]);
    });
    it("resets only one run and clears stale marks after a restart without reordering content", async () => {
        let { store, id } = await setup(["alpha", "beta"]);
        store.markPendingAdjust(id, "alpha", "first-run");
        store.markPendingAdjust(id, "beta", "second-run");
        expect(store.resetPendingAdjustByRun(id, "first-run")).toEqual({ ok: true, reset: 1 });
        expect(store.getPendingMessages(id)![0]).not.toHaveProperty("adjustRunId");
        expect(store.getPendingMessages(id)![1]).toMatchObject({ id: "beta", adjustRunId: "second-run" });
        expect(store.editPendingMessage(id, "alpha", { rawContent: "Edited after reset", visibleContent: "Edited after reset" }).ok).toEqual(true);
        const claim = store.claimPendingMessage(id);
        expect(claim).toMatchObject({ ok: true, claimed: true, userMessage: { content: "Edited after reset" } });
        expect(store.resetPendingAdjustByRun(id, "no-matching-run")).toEqual({ ok: true, reset: 0 });
        store.completePendingDispatch(id, "alpha");
        store.enqueuePendingMessage(id, entry("gamma"));
        store.markPendingAdjust(id, "gamma", "second-run");
        expect(store.getPendingMessages(id)!.every(item => item.adjustRunId === "second-run")).toEqual(true);
        vi.resetModules();
        store = await import("./chats-store");
        store.initialize();
        store.clearStalePendingAdjustMarks();
        expect(ids(store.getPendingMessages(id))).toEqual(["beta", "gamma"]);
        expect(store.getPendingMessages(id)!.every(item => !item.adjustRunId)).toEqual(true);
        expect(store.claimPendingMessage(id)).toMatchObject({ ok: true, claimed: true });
    });
});
describe("queue IPC boundary", () => {
    it("validates queue/edit/claim payloads and forwards authoritative outcomes", async () => {
        const { registerChatsIpc } = await import("./chats-ipc");
        registerChatsIpc();
        const event = { sender: {} };
        const call = (channel: string, payload: any) => profile.handlers.get(channel)(event, payload);
        const session = await call(IPC.CHATS_CREATE, { mode: "work" });
        for (const payload of [null, { sessionId: session.id }])
            expect(await call(IPC.CHATS_PENDING_ENQUEUE, payload)).toEqual({ ok: false, error: "invalid-payload" });
        const payload = { sessionId: session.id, entry: entry("ipc-item") };
        expect(await call(IPC.CHATS_PENDING_ENQUEUE, payload)).toMatchObject({ ok: true, enqueued: true, queue: [expect.objectContaining({ id: "ipc-item" })] });
        expect(await call(IPC.CHATS_PENDING_LIST, session.id)).toEqual([expect.objectContaining({ id: "ipc-item", rawContent: "Queued instruction ipc-item" })]);
        expect(await call(IPC.CHATS_PENDING_ENQUEUE, payload)).toMatchObject({ ok: true, enqueued: false, queue: [expect.objectContaining({ id: "ipc-item" })] });
        for (const payload of [null, { sessionId: session.id, messageId: "ipc-item" }])
            expect(await call(IPC.CHATS_PENDING_EDIT, payload)).toEqual({ ok: false, error: "invalid-payload" });
        expect(await call(IPC.CHATS_PENDING_EDIT, { sessionId: session.id, messageId: "ipc-item", rawContent: "IPC edited", visibleContent: "IPC edited", userSticker: "smile" })).toMatchObject({ ok: true, queue: [expect.objectContaining({ rawContent: "IPC edited", userSticker: "smile" })] });
        expect(await call(IPC.CHATS_PENDING_CLAIM, "")).toEqual({ ok: false, error: "invalid-payload" });
        expect(await call(IPC.CHATS_PENDING_COMPLETE_DISPATCH, { sessionId: session.id })).toEqual({ ok: false, error: "invalid-payload" });
        expect(await call(IPC.CHATS_PENDING_CLAIM, session.id)).toMatchObject({ ok: true, claimed: true, visibleContent: "IPC edited", remainingQueue: [], userMessage: { id: "ipc-item", role: "user" } });
        expect(await call(IPC.CHATS_PENDING_EDIT, { sessionId: session.id, messageId: "ipc-item", rawContent: "Too late", visibleContent: "Too late" })).toMatchObject({ ok: false, error: "already-claimed", queue: [] });
        expect(await call(IPC.CHATS_PENDING_CLAIM, session.id)).toEqual({ ok: false, error: "already-dispatching" });
        expect(await call(IPC.CHATS_PENDING_COMPLETE_DISPATCH, { sessionId: session.id, messageId: "ipc-item" })).toEqual({ ok: true, cleared: true });
        expect(await call(IPC.CHATS_PENDING_COMPLETE_DISPATCH, { sessionId: session.id, messageId: "ipc-item" })).toEqual({ ok: true, cleared: false });
        expect(await call(IPC.CHATS_PENDING_CLAIM, session.id)).toEqual({ ok: true, claimed: false });
        expect(await call(IPC.CHATS_PENDING_CLAIM, "missing-session")).toEqual({ ok: false, error: "session-not-found" });
        await call(IPC.CHATS_PENDING_ENQUEUE, { sessionId: session.id, entry: entry("remove-via-ipc") });
        expect(await call(IPC.CHATS_PENDING_REMOVE, { sessionId: session.id, messageId: "remove-via-ipc" })).toEqual({ ok: true, removed: true });
        expect(await call(IPC.CHATS_PENDING_REMOVE, { sessionId: session.id, messageId: "remove-via-ipc" })).toEqual({ ok: true, removed: false });
        expect(await call(IPC.CHATS_PENDING_REMOVE, { sessionId: "missing-session", messageId: "remove-via-ipc" })).toEqual({ ok: false, error: "session-not-found" });
        expect(await call(IPC.CHATS_PENDING_LIST, session.id)).toEqual([]);
    });
});
