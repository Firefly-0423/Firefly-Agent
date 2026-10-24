import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
const boundary = vi.hoisted(() => ({ root: "", base: "", denyLookup: false, handlers: new Map<string, any>(), open: vi.fn(), save: vi.fn(), confirm: vi.fn() }));
vi.mock("electron", () => ({
    app: { getPath: () => { if (boundary.denyLookup)
            throw new Error("DIRECT_USERDATA_FORBIDDEN"); return boundary.root; } },
    ipcMain: { handle: (channel: string, handler: any) => boundary.handlers.set(channel, handler) },
    shell: { openPath: boundary.open }, BrowserWindow: { getAllWindows: () => [], fromWebContents: () => ({}) },
    dialog: { showSaveDialog: boundary.save, showMessageBox: boundary.confirm, showOpenDialog: vi.fn() },
}));
beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    boundary.handlers.clear();
    boundary.denyLookup = false;
    boundary.open.mockResolvedValue("");
    boundary.base = fs.mkdtempSync(join(tmpdir(), "chat-ipc-contract-"));
    const isolated = join(boundary.base, "isolated"), production = join(boundary.base, "production-fixture");
    fs.mkdirSync(isolated);
    fs.mkdirSync(production);
    const { resolveRuntimeProfile } = await import("../runtime-profile");
    const { initializeStorageContext } = await import("../storage-context");
    boundary.root = initializeStorageContext(resolveRuntimeProfile({ argv: ["--firefly-profile=test", "--firefly-isolation-root=" + isolated], env: {}, isPackaged: false, productionAppData: production })).dataRoot;
});
afterEach(() => fs.rmSync(boundary.base, { recursive: true, force: true }));
const event = () => ({ sender: {} });
const invoke = (channel: string, payload?: unknown, sender = event()): any => boundary.handlers.get(channel)(sender, payload);
async function register(options: any = {}) { const { registerChatsIpc } = await import("./chats-ipc"); registerChatsIpc(undefined, options); return import("./chats-store"); }
const pending = (id: string, rawContent = "Original queued instruction") => ({ id, rawContent, visibleContent: rawContent });
describe("session IPC persistence", () => {
    it("filters modes and omits retired code-mode IPC", async () => {
        await register();
        invoke(IPC.CHATS_CREATE, { mode: "chat" });
        invoke(IPC.CHATS_CREATE, { mode: "work" });
        const code = invoke(IPC.CHATS_CREATE, { mode: "code" });
        expect(invoke(IPC.CHATS_LIST, { mode: "code" })).toEqual([expect.objectContaining({ id: code.id, mode: "code" })]);
        expect(boundary.handlers.get("chats:set-code-mode")).toBeUndefined();
    });
    it("propagates malformed history errors and preserves the unreadable bytes", async () => {
        const directory = join(boundary.root, "firefly-chats");
        fs.mkdirSync(directory, { recursive: true });
        const file = join(directory, "index.json");
        fs.writeFileSync(file, "{invalid-index");
        await register();
        for (const mode of ["chat", "work"])
            await expect(Promise.resolve().then(() => invoke(IPC.CHATS_LIST, { mode }))).rejects.toThrow("CHAT_HISTORY_READ_FAILED");
        expect(fs.readFileSync(file, "utf8")).toEqual("{invalid-index");
    });
    it("creates explicitly temporary Chat sessions outside the list and deletes them", async () => {
        await register();
        const ordinary = invoke(IPC.CHATS_CREATE, { mode: "chat" });
        const temporary = invoke(IPC.CHATS_CREATE, { mode: "chat", temporary: true });
        expect(ordinary.temporary).toBeUndefined();
        expect(temporary.temporary).toEqual(true);
        expect(invoke(IPC.CHATS_LIST).map((item: any) => item.id)).toEqual([ordinary.id]);
        expect(await invoke(IPC.CHATS_GET, temporary.id)).toMatchObject({ id: temporary.id, temporary: true });
        expect(() => invoke(IPC.CHATS_CREATE, { mode: "work", temporary: true })).toThrow("TEMPORARY_CHAT_REQUIRES_CHAT_MODE");
        expect(await invoke(IPC.CHATS_DELETE, temporary.id)).toEqual(true);
        expect(await invoke(IPC.CHATS_GET, temporary.id)).toBeNull();
    });
    it("refuses temporary Chat when its memory owner cannot honor zero persistence", async () => {
        await register({ memory: { appendUser: vi.fn(), mutate: vi.fn(), ownsSession: () => true } });
        expect(() => invoke(IPC.CHATS_CREATE, { mode: "chat", temporary: true })).toThrow("TEMPORARY_CHAT_UNAVAILABLE");
        expect(invoke(IPC.CHATS_CREATE, { mode: "chat" })).toMatchObject({ mode: "chat" });
    });
    it("validates checkpoint payloads before upserting a model message", async () => {
        await register();
        const session = invoke(IPC.CHATS_CREATE, { mode: "work" });
        expect(await invoke(IPC.CHATS_UPSERT, null)).toBeNull();
        expect(await invoke(IPC.CHATS_UPSERT, { id: session.id })).toBeNull();
        expect(await invoke(IPC.CHATS_UPSERT, { id: session.id, message: { id: "checkpoint-message", role: "model", content: "In progress", at: 13 } })).toMatchObject({ messages: [{ id: "checkpoint-message", content: "In progress" }] });
    });
    it("exports the pre-dialog Work snapshot with native overwrite confirmation and honors cancellation", async () => {
        await register();
        const session = invoke(IPC.CHATS_CREATE, { mode: "work" });
        const saveMessage = (content: string) => invoke(IPC.CHATS_UPSERT, { id: session.id, message: { id: "work-answer", role: "model", content, at: 11, runSnapshot: { status: "terminal", terminalStatus: "success", updatedAt: 11 } } });
        await saveMessage("Snapshot before selection");
        let select!: (answer: any) => void;
        boundary.save.mockImplementation(() => new Promise(resolve => { select = resolve; }));
        const saving = invoke(IPC.CHATS_EXPORT_WORK_MARKDOWN, session.id);
        await saveMessage("Changed while selecting");
        const file = join(boundary.root, "exported-work.md");
        select({ canceled: false, filePath: file });
        expect(await saving).toEqual({ ok: true });
        const bytes = fs.readFileSync(file, "utf8");
        expect(bytes).toContain("Snapshot before selection");
        expect(bytes).not.toContain("Changed while selecting");
        expect(boundary.save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ properties: ["showOverwriteConfirmation"] }));
        boundary.save.mockResolvedValue({ canceled: true });
        expect(await invoke(IPC.CHATS_EXPORT_WORK_MARKDOWN, session.id)).toEqual({ ok: false, canceled: true });
        expect(fs.readFileSync(file, "utf8")).toEqual(bytes);
    });
});
describe("queued attachment and title contracts", () => {
    it("binds partial document confirmation to a version and refuses a file changed during confirmation", async () => {
        await register();
        const session = invoke(IPC.CHATS_CREATE, { mode: "work" });
        const filePath = join(boundary.root, "selected-lines.txt");
        fs.writeFileSync(filePath, Array.from({ length: 2001 }, (_, n) => `record-${n}`).join("\n"));
        boundary.confirm.mockResolvedValue({ response: 1 });
        const request = { sessionId: session.id, entry: { ...pending("required-read"), requireDocumentRead: true, attachments: [{ kind: "document", name: "selected-lines.txt", filePath }] } };
        const result = await invoke(IPC.CHATS_PENDING_ENQUEUE, request);
        expect(result.ok).toEqual(true);
        expect(result.queue[0].attachments[0].readScope).toMatchObject({ endLine: 2000, totalLines: 2001, partialAccepted: true });
        expect((await invoke(IPC.CHATS_PENDING_CLAIM, session.id)).userMessage.attachments[0].readScope.endLine).toEqual(2000);
        expect(boundary.confirm).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ detail: expect.stringContaining("2001") }));
        boundary.confirm.mockImplementation(async () => { fs.appendFileSync(filePath, "\nrevision"); return { response: 1 }; });
        expect(await invoke(IPC.CHATS_PENDING_ENQUEUE, { ...request, entry: { ...request.entry, id: "changed-read" } })).toEqual({ ok: false, error: "file-changed-before-enqueue" });
    });
    it("drops renderer-forged read scopes when Main has not confirmed them", async () => {
        await register();
        const session = invoke(IPC.CHATS_CREATE, { mode: "work" });
        const result = await invoke(IPC.CHATS_PENDING_ENQUEUE, { sessionId: session.id, entry: { ...pending("forged-read"), attachments: [{ kind: "document", name: "notes.md", filePath: "E:\\fixtures\\notes.md", readScope: { endLine: 1, partialAccepted: true } }] } });
        expect(result.ok).toEqual(true);
        expect(result.queue[0].attachments[0].readScope).toBeUndefined();
    });
    it("schedules first-message titles in every mode using only visible queued text", async () => {
        const schedule = vi.fn(() => true);
        await register({ titleService: { schedule } });
        for (const mode of ["chat", "work", "code"]) {
            const session = invoke(IPC.CHATS_CREATE, { mode });
            await invoke(IPC.CHATS_PENDING_ENQUEUE, { sessionId: session.id, entry: { ...pending(`initial-${mode}`, `Plan ${mode}[sticker:smile]`), visibleContent: `Plan ${mode}`, attachments: [{ kind: "document", name: "brief.md", filePath: "E:\\fixtures\\brief.md" }] } });
            await invoke(IPC.CHATS_PENDING_CLAIM, session.id);
        }
        expect(schedule.mock.calls.map(([input]) => input)).toEqual(["chat", "work", "code"].map(mode => expect.objectContaining({ userMessageId: `initial-${mode}`, text: `Plan ${mode}` })));
    });
    it("strips sticker markers from legacy direct appends before title scheduling", async () => {
        const schedule = vi.fn(() => true);
        await register({ titleService: { schedule } });
        const session = invoke(IPC.CHATS_CREATE, { mode: "chat" });
        await invoke(IPC.CHATS_APPEND, { id: session.id, message: { id: "direct-user", role: "user", content: "  Summarize the brief [sticker:smile]  ", at: 17, attachments: [{ kind: "document", name: "private.md", filePath: "E:\\fixtures\\private.md", status: "pending" }] } });
        expect(schedule.mock.calls.map(([input]) => input)).toEqual([{ sessionId: session.id, userMessageId: "direct-user", text: "Summarize the brief" }]);
    });
});
describe("canonical conversation recovery and deletion", () => {
    it("projects settlement without mutating cached messages or transcript entries", async () => {
        const cache = await register();
        const { getConversationTranscriptStore } = await import("../orchestrator/conversation-transcript-store");
        const { createTranscriptSink } = await import("../orchestrator/transcript-sink");
        const session = cache.createSession({ mode: "chat" });
        const store = getConversationTranscriptStore(boundary.root);
        cache.appendMessage(session.id, { id: "human", role: "user", content: "A real question", at: 1 });
        cache.appendMessage(session.id, { id: "answer", role: "model", content: "Cached answer", answersUserMessageId: "human", at: 2, ttsCacheKey: "stale-tts", runSnapshot: { runId: "cached-run", status: "terminal", terminalStatus: "success", updatedAt: 2 } });
        await store.append(session.id, { kind: "user", id: "human", turnId: "human", revision: 1, at: 1, payload: { text: "A real question" } });
        const binding = { runId: "canonical-run", assistantTurnId: "answer", userTurnId: "human", userRevision: 1 };
        const sink = createTranscriptSink({ store, conversationId: session.id, runId: binding.runId, assistantTurnId: binding.assistantTurnId });
        const assistantEntryId = await sink.appendSAssistant({ message: { role: "assistant", content: "Canonical answer" }, binding });
        const before = JSON.stringify((await store.read(session.id)).entries), cacheBefore = JSON.stringify(cache.getSession(session.id));
        boundary.denyLookup = true;
        expect((await invoke(IPC.CHATS_GET, session.id)).messages.find((item: any) => item.id === "answer")).toMatchObject({ content: "", sSettlement: { state: "pending", originalText: "Canonical answer" } });
        expect(JSON.stringify((await store.read(session.id)).entries)).toEqual(before);
        expect(JSON.stringify(cache.getSession(session.id))).toEqual(cacheBefore);
        await sink.settleSAssistant({ binding: { ...binding, assistantEntryId }, result: "success", safeReason: "fixture_completion" });
        const recovered = (await invoke(IPC.CHATS_GET, session.id)).messages.find((item: any) => item.id === "answer");
        expect(recovered).toMatchObject({ content: "Canonical answer", sSettlement: { state: "success" }, runSnapshot: { status: "terminal", terminalStatus: "success" } });
        expect(JSON.stringify(cache.getSession(session.id))).toEqual(cacheBefore);
        expect(cache.getSession(session.id)!.messages[1].runSnapshot!.runId).toEqual("cached-run");
        expect((await invoke(IPC.CHATS_GET, session.id)).messages[1]).toMatchObject({ content: "Canonical answer", sSettlement: { state: "success" }, runSnapshot: { runId: "canonical-run" } });
        await invoke(IPC.CHATS_UPSERT, { id: session.id, message: { ...recovered, content: "Cache-only update" } });
        expect(cache.getSession(session.id)!.messages[1].sSettlement).toBeUndefined();
        expect((await invoke(IPC.CHATS_GET, session.id)).messages[1].content).toEqual("Canonical answer");
    });
    it("deletes only the selected conversation's tool outputs and transcript", async () => {
        await register();
        const { FileToolOutputStore } = await import("../orchestrator/harness/tool-output/file-tool-output-store");
        const { getConversationTranscriptStore } = await import("../orchestrator/conversation-transcript-store");
        const first = invoke(IPC.CHATS_CREATE, { mode: "work" }), second = invoke(IPC.CHATS_CREATE, { mode: "work" });
        const outputs = new FileToolOutputStore(boundary.root), transcripts = getConversationTranscriptStore(boundary.root);
        const put = (id: string, output: string) => outputs.put({ conversationId: id, runId: "tool-run", toolCallId: "read-call", toolName: "read_file", outcome: "success", output, truncatedForModel: false });
        const a = await put(first.id, "Deleted output"), b = await put(second.id, "Retained output");
        for (const [n, session] of [first, second].entries())
            await transcripts.append(session.id, { kind: "user", id: `entry-${n}`, turnId: `turn-${n}`, revision: 1, at: 1, payload: { text: `Question ${n}` } });
        expect(await invoke(IPC.CHATS_DELETE, first.id)).toEqual(true);
        expect(await outputs.read({ conversationId: first.id, resultRef: a.resultRef, offset: 0, length: 100 })).toBeNull();
        expect(await outputs.read({ conversationId: second.id, resultRef: b.resultRef, offset: 0, length: 100 })).toMatchObject({ content: "Retained output" });
        expect(fs.existsSync(join(boundary.root, first.id))).toEqual(false);
        expect((await transcripts.read(first.id)).entries).toEqual([]);
        expect((await transcripts.read(second.id)).entries).toEqual([expect.objectContaining({ id: "entry-1" })]);
    });
    it("opens only a directory already bound to a project conversation", async () => {
        await register();
        const session = invoke(IPC.CHATS_CREATE, { mode: "work" });
        const workspaceRoot = join(boundary.base, "project"), unrelated = join(boundary.base, "other");
        fs.mkdirSync(workspaceRoot);
        fs.mkdirSync(unrelated);
        await invoke(IPC.CHATS_SET_WORKSPACE, { sessionId: session.id, workspaceRoot });
        expect(await invoke(IPC.CHATS_OPEN_WORKSPACE, unrelated)).toEqual({ ok: false, error: "workspace is not bound to a conversation" });
        expect(boundary.open).not.toHaveBeenCalled();
        expect(await invoke(IPC.CHATS_OPEN_WORKSPACE, workspaceRoot)).toEqual({ ok: true });
        expect(boundary.open).toHaveBeenCalledExactlyOnceWith(fs.realpathSync(workspaceRoot));
    });
});
describe("authenticated Main user admission", () => {
    it.each([false, true])("leaves cached history unchanged when Main denies queued=%s", async (queued) => {
        const appendUser = vi.fn(async () => { throw new Error("MEMORY_DESKTOP_SESSION_DENIED"); });
        const cache = await register({ memory: { appendUser, mutate: vi.fn() } });
        const session = cache.createSession({ mode: "chat" });
        if (queued)
            cache.enqueuePendingMessage(session.id, pending("denied-user"));
        const outcome = queued ? invoke(IPC.CHATS_PENDING_CLAIM, session.id) : invoke(IPC.CHATS_APPEND, { id: session.id, message: { id: "denied-user", role: "user", content: "Human input", at: 1 } });
        await expect(outcome).rejects.toThrow("MEMORY_DESKTOP_SESSION_DENIED");
        expect(cache.getSession(session.id)?.messages).toEqual([]);
        expect(appendUser).toHaveBeenCalledTimes(1);
        if (queued)
            expect(cache.getPendingMessages(session.id)?.map(item => item.id)).toEqual(["denied-user"]);
    });
    it("admits the stable queued document scope before changing history", async () => {
        const sender = event();
        let cache: any;
        const seen: any[] = [];
        cache = await register({ memory: { appendUser: async (received: any, id: string, message: any, commit: any) => { expect(received).toBe(sender); expect(cache.getSession(id).messages).toEqual([]); seen.push(message); return commit(); }, mutate: vi.fn() } });
        const session = cache.createSession({ mode: "work" });
        const readScope = { name: "approved.txt", path: "/fixtures/approved.txt", sha256: "b".repeat(64), totalLines: 7, endLine: 3, partialAccepted: true };
        cache.enqueuePendingMessage(session.id, { ...pending("approved-user"), visibleContent: "Visible instruction", attachments: [{ kind: "document", name: readScope.name, filePath: readScope.path, readScope }] });
        expect(await invoke(IPC.CHATS_PENDING_CLAIM, session.id, sender)).toMatchObject({ ok: true, claimed: true, userMessage: { id: "approved-user", content: "Original queued instruction", attachments: [{ readScope }] } });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ id: "approved-user", role: "user", content: "Original queued instruction", attachments: [{ readScope }] });
    });
    it("does not promote a replacement head while source authorization is pending", async () => {
        let release!: () => void, entered!: () => void;
        const wait = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
        const commits: any[] = [];
        const cache = await register({ memory: { appendUser: async (_e: any, _id: string, _message: any, commit: any) => { entered(); await wait; const result = commit(); commits.push(result); return result; }, mutate: vi.fn() } });
        const session = cache.createSession({ mode: "chat" });
        cache.enqueuePendingMessage(session.id, pending("head"));
        cache.enqueuePendingMessage(session.id, pending("next"));
        const checked = expect(invoke(IPC.CHATS_PENDING_CLAIM, session.id)).rejects.toThrow("MEMORY_SOURCE_STALE");
        await started;
        cache.removePendingMessage(session.id, "head");
        release();
        await checked;
        expect(commits).toEqual([false]);
        expect(cache.getSession(session.id)?.messages).toEqual([]);
        expect(cache.getPendingMessages(session.id)?.map(item => item.id)).toEqual(["next"]);
    });
    it("retains authorized attachment references on text edits and rejects replacement references", async () => {
        const mutate = vi.fn(async (_e, _id, ids, commit) => { expect(ids).toEqual(["editable-user"]); return commit(); });
        const cache = await register({ memory: { usesCanonicalUserContent: true, ownsSession: () => true, appendUser: vi.fn(), mutate } });
        const session = cache.createSession({ mode: "work" });
        const attachment = { kind: "document" as const, name: "same.md", filePath: "/fixtures/same.md", status: "pending" as const, readScope: { name: "same.md", path: "/fixtures/same.md", sha256: "c".repeat(64), endLine: 3, totalLines: 7, partialAccepted: true } };
        const user = { id: "editable-user", role: "user" as const, content: "Before edit", at: 1, attachments: [attachment] };
        cache.appendMessage(session.id, user);
        await expect(invoke(IPC.CHATS_REPLACE_TAIL, { id: session.id, startIndex: 0, messages: [{ ...user, content: "After edit" }] })).resolves.toMatchObject({ messages: [{ content: "After edit", attachments: [{ readScope: attachment.readScope }] }] });
        expect(mutate).toHaveBeenCalledTimes(1);
        await expect(invoke(IPC.CHATS_REPLACE_TAIL, { id: session.id, startIndex: 0, messages: [{ ...user, content: "Another edit", attachments: [{ ...attachment, filePath: "/fixtures/replacement.md" }] }] })).rejects.toThrow("MEMORY_ATTACHMENT_DENIED");
        expect(mutate).toHaveBeenCalledTimes(1);
    });
    it("issues a direct-user receipt containing the queued human text without attachment bytes", async () => {
        const { EventEmitter } = await import("node:events");
        const { createMainDesktopSessionAuthority } = await import("../memory-context/main-desktop-session-authority");
        const { createActiveChatTargetRegistry } = await import("../plugin-host/active-chat-target");
        const { createDesktopUserSourceProvider } = await import("../memory-sources/desktop-user-source-provider");
        const { requireMainSourceProvider } = await import("../memory-sources/main-source-provider");
        const cache = await import("./chats-store");
        cache.initialize();
        const sender = Object.assign(new EventEmitter(), { id: 381, mainFrame: {}, isDestroyed: () => false }), targets = createActiveChatTargetRegistry(), received = { sender, senderFrame: sender.mainFrame };
        const session = cache.createSession({ mode: "chat" });
        targets.setActive({ sender: sender as any, sessionId: session.id, mode: "chat", rendererTargetId: "receipt-renderer" });
        const authority = createMainDesktopSessionAuthority({ enabled: true, scopeKey: "fixture-scope", actorKey: "fixture-actor", getChatWindow: () => ({ webContents: sender, isDestroyed: () => false }) as any, targets, getSession: id => cache.getSession(id), isControlledSession: () => true })!;
        const source = createDesktopUserSourceProvider({ authority, providerId: "receipt-provider", scopeKey: "fixture-scope", clock: () => 2300, readUser: identity => { const user = cache.getSession(identity.sessionId)?.messages.find(item => item.id === identity.messageId); return user?.role === "user" ? { role: user.role, text: user.content } : null; } });
        await register({ memory: { ownsSession: () => true, mutate: async (_e: any, _id: string, _ids: string[], commit: any) => commit(), appendUser: async (e: any, id: string, message: any, commit: any) => { const grant = authority.bind(e, id); return source.mutate(() => { const ticket = source.prepareUserCommit(grant, id, message.id), result = commit(); if (result === false)
                    source.cancelUserCommit(ticket);
                else
                    source.finishUserCommit(ticket); return result; }); } } });
        try {
            cache.enqueuePendingMessage(session.id, { ...pending("receipt-user", "I prefer coastal routes"), attachments: [{ kind: "document", name: "unread.md", filePath: "/fixtures/unread.md" }] });
            await invoke(IPC.CHATS_PENDING_CLAIM, session.id, received);
            const identity = { providerId: "receipt-provider", sessionId: session.id, messageId: "receipt-user" };
            const provider = requireMainSourceProvider(source.token, "fixture-scope", identity);
            const receipt = await provider.withLease(identity, read => read());
            expect(receipt).toMatchObject({ text: "I prefer coastal routes", role: "user", trust: "direct-user-event", contentRevision: 1 });
            expect(JSON.stringify(receipt)).not.toContain("unread.md");
        }
        finally {
            authority.dispose();
        }
    });
});
