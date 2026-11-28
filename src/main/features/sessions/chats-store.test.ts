import fs from "fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../../shared/chat-types";
const profile = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: { getPath: () => profile.root }, shell: { openPath: vi.fn() } }));
beforeEach(() => { vi.resetModules(); profile.root = fs.mkdtempSync(join(tmpdir(), "session-contract-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(profile.root, { recursive: true, force: true }); });
const indexPath = () => join(profile.root, "firefly-chats", "index.json");
function index(text: string) { fs.mkdirSync(join(profile.root, "firefly-chats", "sessions"), { recursive: true }); fs.writeFileSync(indexPath(), text); }
const message = (id: string, content: string, role: "user" | "model" = "user") => ({ id, content, role, at: 17 });
async function ready() { const store = await import("./chats-store"); store.initialize(); return store; }
describe("terminal snapshots on disk (ChatPage A7/A10)", () => {
    const controlId = "00000000-0000-4000-8000-000000000001";
    const sessionId = "00000000-0000-4000-8000-000000000002";
    const sessionsPath = () => join(profile.root, "firefly-chats", "sessions");
    const sessionPath = (id: string) => join(sessionsPath(), `${id}.json`);
    const controlMessage = message("control-message", "对照正文\n必须逐字节保留", "model");

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-11-15T08:00:00.000Z"));
        const actual = await vi.importActual<typeof import("crypto")>("crypto");
        vi.doMock("crypto", () => ({
            ...actual,
            randomUUID: vi.fn().mockReturnValueOnce(controlId).mockReturnValueOnce(sessionId),
        }));
    });
    afterEach(() => { vi.useRealTimers(); vi.doUnmock("crypto"); });

    function snapshot(status: NonNullable<ChatMessage["runSnapshot"]>["status"],
        content: string, terminalStatus?: NonNullable<ChatMessage["runSnapshot"]>["terminalStatus"]): ChatMessage {
        return {
            id: "assistant-message", role: "model", at: Date.now(), content,
            reasoning: "先核对输入，再整理结果。\n保留推理文本。",
            processMessages: [{ id: "process-message", content: "已读取输入", afterToolCount: 1, seq: 2 }],
            toolExecutions: [{ id: "tool-execution", name: "read_file", argsText: '{"path":"input.txt"}',
                status: "success", result: "输入内容", seq: 1 }],
            runSnapshot: { runId: "run-snapshot", status, updatedAt: Date.now(),
                ...(terminalStatus === undefined ? {} : { terminalStatus }) },
        };
    }

    async function arrangeSessions() {
        const store = await ready();
        const control = store.createSession({ mode: "chat", initialMessages: [controlMessage] });
        const controlBytes = fs.readFileSync(sessionPath(control.id), "utf8");
        const session = store.createSession({ mode: "chat" });
        expect([control.id, session.id]).toStrictEqual([controlId, sessionId]);
        return { store, controlBytes };
    }

    function expectControlUnchanged(store: Awaited<ReturnType<typeof ready>>, controlBytes: string) {
        expect(store.getSession(controlId)?.messages).toStrictEqual([controlMessage]);
        expect(fs.readFileSync(sessionPath(controlId), "utf8")).toBe(controlBytes);
        expect(fs.readdirSync(sessionsPath()).sort()).toStrictEqual([
            `${controlId}.json`, `${sessionId}.json`,
        ]);
    }

    it.each([
        { terminalStatus: "success", content: "完整回答\n全部完成。" },
        { terminalStatus: "cancelled", content: "取消前的部分输出……" },
        { terminalStatus: "timeout", content: "超时前已保存的输出。" },
        { terminalStatus: "runtime_error", content: "运行出错前的部分输出……" },
    ] as const)("preserves the complete $terminalStatus message after saving and reloading without changing other sessions", async ({ terminalStatus, content }) => {
        let { store, controlBytes } = await arrangeSessions();
        store.upsertMessage(sessionId, snapshot("running", "尚未完成"));
        const expected = snapshot("terminal", content, terminalStatus);
        store.upsertMessage(sessionId, expected);

        vi.resetModules();
        store = await ready();

        const messages = store.getSession(sessionId)?.messages;
        expect(messages).toStrictEqual([expected]);
        expect(messages?.[0].runSnapshot?.status).toBe("terminal");
        expect(messages?.[0].runSnapshot?.terminalStatus).toBe(terminalStatus);
        expectControlUnchanged(store, controlBytes);
    });

    it("preserves running and waiting_user checkpoints verbatim after reloading without changing other sessions", async () => {
        let { store, controlBytes } = await arrangeSessions();
        const expected: ChatMessage[] = [
            snapshot("running", "运行中的部分输出"),
            { ...snapshot("waiting_user", "等待用户确认"), id: "waiting-assistant-message",
                runSnapshot: { runId: "waiting-run", status: "waiting_user", updatedAt: Date.now() } },
        ];
        for (const item of expected) store.upsertMessage(sessionId, item);

        vi.resetModules();
        store = await ready();

        expect(store.getSession(sessionId)?.messages).toStrictEqual(expected);
        expectControlUnchanged(store, controlBytes);
    });

    it("rejects an update blocked by a staging directory and reloads the confirmed terminal message with both disk files unchanged", async () => {
        let { store, controlBytes } = await arrangeSessions();
        const confirmed = snapshot("terminal", "已确认的完整回答", "success");
        store.upsertMessage(sessionId, confirmed);
        const sessionBytes = fs.readFileSync(sessionPath(sessionId), "utf8");
        const indexBytes = fs.readFileSync(indexPath(), "utf8");
        const stagingPath = `${sessionPath(sessionId)}.tmp`;
        fs.mkdirSync(stagingPath);
        vi.setSystemTime(Date.now() + 1000);
        const unconfirmed = snapshot("running", "不能落盘的新版本（半截输出）");

        let failure: unknown;
        try {
            store.upsertMessage(sessionId, unconfirmed);
        } catch (error) {
            failure = error;
        }

        // Keep disk comparisons observable even when a mutation stops rejecting the write.
        expect.soft(failure).toBeInstanceOf(Error);
        expect.soft(fs.readFileSync(sessionPath(sessionId), "utf8")).toBe(sessionBytes);
        expect.soft(fs.readFileSync(indexPath(), "utf8")).toBe(indexBytes);
        expect(store.getSession(sessionId)?.messages).toStrictEqual([confirmed]);

        fs.rmdirSync(stagingPath);
        vi.resetModules();
        store = await ready();

        expect(store.getSession(sessionId)?.messages).toStrictEqual([confirmed]);
        expect(fs.readFileSync(sessionPath(sessionId), "utf8")).toBe(sessionBytes);
        expect(fs.readFileSync(indexPath(), "utf8")).toBe(indexBytes);
        expectControlUnchanged(store, controlBytes);
    });
});

describe("session metadata and content", () => {
    it("does not repair invalid persisted modes or allow writes over unreadable history", async () => {
        const bytes = JSON.stringify([{ id: "retired-session", title: "Retired", createdAt: 5, updatedAt: 7, messageCount: 0, identityId: null, mode: "learn" }]);
        index(bytes);
        const store = await ready();
        expect(() => store.listSessions()).toThrow("CHAT_HISTORY_READ_FAILED");
        expect(() => store.createSession({ mode: "work" })).toThrow("CHAT_HISTORY_READ_FAILED");
        expect(fs.readFileSync(indexPath(), "utf8")).toEqual(bytes);
    });
    it("rejects retired and unknown requested modes without creating sessions", async () => {
        const store = await ready();
        for (const mode of ["learn", "unknown-mode"]) {
            expect(() => store.createSession({ mode } as never)).toThrow("INVALID_CONVERSATION_MODE");
            expect(() => store.listSessions({ mode } as never)).toThrow("INVALID_CONVERSATION_MODE");
        }
        expect(store.listSessions()).toEqual([]);
    });
    it("reports total counts on paginated history and upserts messages without reordering", async () => {
        const store = await ready();
        const session = store.createSession({ initialMessages: [message("question", "Start"), message("reply", "", "model"), message("followup", "Continue")] });
        expect(store.getSessionPage(session.id, null, 2)?.messages).toHaveLength(2);
        expect(store.getSessionPage(session.id, null, 2)?.session.messageCount).toEqual(3);
        store.upsertMessage(session.id, message("reply", "Progress", "model"));
        store.upsertMessage(session.id, message("final", "Finished", "model"));
        expect(store.getSession(session.id)?.messages.map(item => item.id)).toEqual(["question", "reply", "followup", "final"]);
        expect(store.getSession(session.id)?.messages[1].content).toEqual("Progress");
        expect(store.listSessions().find(item => item.id === session.id)?.messageCount).toEqual(4);
    });
    it("indexes immutable modes, filters by mode and includes workspace grouping metadata", async () => {
        const store = await ready();
        const sessions = ["chat", "work", "code"].map(mode => store.createSession({ mode: mode as any }));
        expect(store.listSessions().map(item => item.mode).sort()).toEqual(["chat", "code", "work"]);
        expect(store.listSessions({ mode: "code" })).toEqual([expect.objectContaining({ id: sessions[2].id, mode: "code" })]);
        expect(new Set(store.listSessions().map(item => item.id))).toEqual(new Set(sessions.map(item => item.id)));
        const workspaceRoot = join(profile.root, "design-workspace");
        fs.mkdirSync(workspaceRoot);
        store.setWorkspaceBinding(sessions[1].id, { workspaceRoot, displayName: "design-workspace", boundAt: 61 });
        expect(store.listSessions({ mode: "work" })).toContainEqual(expect.objectContaining({ id: sessions[1].id, workspaceRoot, workspaceDisplayName: "design-workspace" }));
    });
    it("persists purpose identity across restart and recreates a deleted singleton", async () => {
        let store = await ready();
        const first = store.createSession({ purpose: "proactive-chat", title: "Scheduled greetings" });
        expect(store.listSessions()).toContainEqual(expect.objectContaining({ id: first.id, purpose: "proactive-chat" }));
        vi.resetModules();
        store = await ready();
        expect(store.getSessionByPurpose("proactive-chat")?.id).toEqual(first.id);
        expect(store.getSession(first.id)?.purpose).toEqual("proactive-chat");
        const repeated = await Promise.all(Array.from({ length: 8 }, async () => store.getOrCreateSessionByPurpose("proactive-chat", { title: "Scheduled greetings" })));
        expect(new Set(repeated.map(item => item.id)).size).toEqual(1);
        expect(store.listSessions().filter(item => item.purpose === "proactive-chat")).toHaveLength(1);
        store.appendMessage(first.id, message("greeting", "Welcome back", "model"));
        expect(store.getSession(first.id)?.title).toEqual("Scheduled greetings");
        expect(store.deleteSession(first.id)).toEqual(true);
        const replacement = store.getOrCreateSessionByPurpose("proactive-chat", { title: "Scheduled greetings" });
        expect(replacement.id).not.toBe(first.id);
        expect(store.getSessionByPurpose("proactive-chat")?.id).toEqual(replacement.id);
    });
    it("stores generated titles without changing recency or treating them as manual names", async () => {
        const store = await ready();
        const session = store.createSession({ mode: "work", initialMessages: [message("initial", "Plan a coastal trip")] });
        expect(store.setGeneratedTitle(session.id, "initial", "Coastal travel")).toEqual(true);
        expect(store.getSession(session.id)).toMatchObject({ title: "Coastal travel", updatedAt: session.updatedAt });
        expect(store.getSession(session.id)?.titleIsCustom).not.toBe(true);
        expect(store.listSessions().find(item => item.id === session.id)?.title).toEqual("Coastal travel");
        store.renameSession(session.id, "Personal travel notes");
        expect(store.setGeneratedTitle(session.id, "initial", "Stale generated title")).toEqual(false);
        expect(store.getSession(session.id)?.title).toEqual("Personal travel notes");
        const changed = store.createSession({ initialMessages: [message("replacement-question", "Updated travel question")] });
        expect(store.setGeneratedTitle(changed.id, "obsolete-question", "Outdated title")).toEqual(false);
        expect(store.getSession(changed.id)?.title).toEqual("Updated travel question");
    });
});
describe("session kind", () => {
    it("answers mode and temporariness from the index and memory without reading session files", async () => {
        const store = await ready();
        const work = store.createSession({ mode: "work" }), temporary = store.createSession({ mode: "chat", temporary: true });
        const read = vi.spyOn(fs, "readFileSync");
        expect(store.getSessionKind(work.id)).toEqual({ mode: "work", temporary: false });
        expect(store.getSessionKind(temporary.id)).toEqual({ mode: "chat", temporary: true });
        expect(store.getSessionKind("missing-session")).toBeNull();
        expect(read).not.toHaveBeenCalled();
        store.deleteSession(work.id);
        expect(store.getSessionKind(work.id)).toBeNull();
    });
});
describe("coverage census", () => {
    it.each([false, true])("performs no disk operations when initialized=%s", async (initialized) => {
        const store = await import("./chats-store");
        const session = initialized ? (store.initialize(), store.createSession({ mode: "chat" })) : undefined;
        const spies = ["readFileSync", "writeFileSync", "mkdirSync", "readdirSync", "statSync", "existsSync"].map(name => vi.spyOn(fs, name as "readFileSync"));
        const result = store.getCachedSessionIdsForCoverage();
        expect(result).toEqual(initialized ? { state: "ready", rootDir: join(profile.root, "firefly-chats"), ids: [session!.id] } : { state: "not-ready", ids: null });
        if (result.state === "ready")
            expect(Object.isFrozen(result.ids)).toEqual(true);
        for (const spy of spies)
            expect(spy).not.toHaveBeenCalled();
    });
    it("reports failed reads and stops before copying more than ten thousand IDs", async () => {
        index("unreadable-history");
        let store = await ready();
        expect(store.getCachedSessionIdsForCoverage()).toEqual({ state: "read-failed", ids: null });
        vi.resetModules();
        index(JSON.stringify(Array.from({ length: 10001 }, (_, n) => ({ id: `cached-${n}`, title: "Fixture", createdAt: 4, updatedAt: 4, messageCount: 0, mode: "chat" }))));
        store = await ready();
        expect(store.getCachedSessionIdsForCoverage()).toEqual({ state: "budget-exhausted", ids: null });
    });
});
describe("temporary conversation lifetime", () => {
    it("keeps messages, pending content and pin state entirely outside persistent history", async () => {
        const store = await ready();
        const { ephemeralConversations } = await import("../../base/storage/ephemeral-conversations");
        const persistent = store.createSession({ mode: "chat", title: "Keep this conversation" });
        const before = fs.readFileSync(indexPath(), "utf8");
        const temporary = store.createSession({ mode: "chat", temporary: true });
        expect(temporary.temporary).toEqual(true);
        expect(ephemeralConversations.has(temporary.id)).toEqual(true);
        store.appendMessage(temporary.id, message("private-input", "Private travel details"));
        store.enqueuePendingMessage(temporary.id, { id: "private-pending", rawContent: "Private followup", visibleContent: "Private followup" });
        store.setSessionPinned(temporary.id, true);
        expect(store.getSession(temporary.id)?.messages.map(item => item.content)).toEqual(["Private travel details"]);
        expect(store.getSessionPage(temporary.id, null, 10)?.messages).toHaveLength(1);
        expect(store.listSessions().map(item => item.id)).toEqual([persistent.id]);
        expect(store.getLatestSessionId()).toEqual(persistent.id);
        expect(store.getCachedSessionIdsForCoverage()).toMatchObject({ ids: [persistent.id] });
        const files = fs.readdirSync(join(profile.root, "firefly-chats", "sessions"));
        expect(files).toEqual([persistent.id + ".json"]);
        expect(fs.readFileSync(indexPath(), "utf8")).toEqual(before);
        expect(JSON.stringify(fs.readdirSync(profile.root, { recursive: true }))).not.toContain(temporary.id);
        expect(store.deleteSession(temporary.id)).toEqual(true);
        expect(store.getSession(temporary.id)).toBeNull();
        expect(ephemeralConversations.has(temporary.id)).toEqual(true);
    });
    it("does not restore temporary history after restart", async () => {
        let store = await ready();
        const session = store.createSession({ mode: "chat", temporary: true });
        store.appendMessage(session.id, message("private-input", "Discard at restart"));
        vi.resetModules();
        store = await ready();
        expect(store.getSession(session.id)).toBeNull();
        expect(store.listSessions()).toEqual([]);
    });
    it("rejects temporary sessions outside explicitly requested Chat mode", async () => {
        const store = await ready();
        for (const opts of [{ mode: "work" }, { mode: "code" }, { purpose: "proactive-chat" }, {}])
            expect(() => store.createSession({ ...opts, temporary: true } as any)).toThrow("TEMPORARY_CHAT_REQUIRES_CHAT_MODE");
        expect(store.listSessions()).toEqual([]);
    });
    it("remains usable without rewriting an unreadable persistent index", async () => {
        index("broken-index");
        const store = await ready();
        const session = store.createSession({ mode: "chat", temporary: true });
        store.appendMessage(session.id, message("private-input", "Available in memory"));
        expect(store.getSession(session.id)?.messages).toHaveLength(1);
        expect(fs.readFileSync(indexPath(), "utf8")).toEqual("broken-index");
    });
});


describe("registered run identities", () => {
    it("persists identity before execution and reports interrupted after reloading", async () => {
        let store = await ready();
        const session = store.createSession({ mode: "chat" });
        const identity = { profileId: store.RUN_PRESENTATION_PROFILE_ID, sessionId: session.id, assistantTurnId: "assistant", runId: "run-one" };
        expect(store.registerRun(identity)).toBe(true);
        expect(store.getRunStatus(session.id, "assistant")).toEqual({ sessionId: session.id, assistantTurnId: "assistant", runId: "run-one", seq: 1, phase: "running" });
        expect(store.getSession(session.id)?.messages).toEqual([{ id: "assistant", role: "model", content: "", at: expect.any(Number) }]);
        expect(store.registerRun({ ...identity, runId: "run-other" })).toBe(false);
        vi.resetModules(); store = await ready();
        expect(store.getRunStatus(session.id, "assistant")).toEqual({ sessionId: session.id, assistantTurnId: "assistant", runId: "run-one", seq: 2, phase: "interrupted" });
        expect(store.getRunStatus(session.id, "unknown")).toBeUndefined();
    });
    it("does not guess a run from legacy snapshots without a trusted mapping", async () => {
        const store = await ready();
        const session = store.createSession({ mode: "chat", initialMessages: [{ ...message("legacy", "old answer", "model"), runSnapshot: { runId: "legacy-run", status: "terminal", terminalStatus: "success", updatedAt: 1 } }] });
        expect(store.getRunStatus(session.id, "legacy")).toBeUndefined();
        expect(store.getRunStatus(session.id, "missing")).toBeUndefined();
    });
    it("reports an unfinished settlement interrupted after restart without durable final evidence", async () => {
        let store = await ready();
        const session = store.createSession({ mode: "chat" });
        const identity = { profileId: store.RUN_PRESENTATION_PROFILE_ID, sessionId: session.id, assistantTurnId: "assistant", runId: "run" };
        store.registerRun(identity);
        expect(store.updateRunPresentation(identity, "settling", 2)).toBe(true);
        expect(store.getRunStatus(session.id, "assistant")?.phase).toBe("settling");
        vi.resetModules(); store = await ready();
        expect(store.getRunStatus(session.id, "assistant")).toEqual({ sessionId: session.id, assistantTurnId: "assistant", runId: "run", seq: 3, phase: "interrupted" });
    });
    it("keeps temporary run registration off disk and rejects user row and profile mismatches", async () => {
        const store = await ready();
        const session = store.createSession({ mode: "chat", temporary: true, initialMessages: [message("user", "hello"), message("old-assistant", "already answered", "model")] });
        const identity = { profileId: store.RUN_PRESENTATION_PROFILE_ID, sessionId: session.id, assistantTurnId: "assistant", runId: "run-one" };
        expect(store.registerRun({ ...identity, assistantTurnId: "user" })).toBe(false);
        expect(store.registerRun({ ...identity, assistantTurnId: "old-assistant" })).toBe(false);
        expect(store.registerRun({ ...identity, profileId: "other-profile" })).toBe(false);
        expect(store.registerRun(identity)).toBe(true);
        expect(fs.existsSync(join(profile.root, "firefly-chats", "sessions", `${session.id}.json`))).toBe(false);
    });
    it("does not expose a running identity after registration cannot be persisted", async () => {
        const store = await ready();
        const session = store.createSession({ mode: "chat" });
        fs.mkdirSync(join(profile.root, "firefly-chats", "sessions", `${session.id}.json.tmp`));
        expect(() => store.registerRun({ profileId: store.RUN_PRESENTATION_PROFILE_ID, sessionId: session.id, assistantTurnId: "assistant", runId: "run-one" })).toThrow();
        expect(store.getRunStatus(session.id, "assistant")).toBeUndefined();
        expect(store.getSession(session.id)?.messages).toEqual([]);
    });
});
