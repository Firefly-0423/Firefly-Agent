import fs from "fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const profile = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: { getPath: () => profile.root }, shell: { openPath: vi.fn() } }));
beforeEach(() => { vi.resetModules(); profile.root = fs.mkdtempSync(join(tmpdir(), "session-contract-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(profile.root, { recursive: true, force: true }); });
const indexPath = () => join(profile.root, "firefly-chats", "index.json");
function index(text: string) { fs.mkdirSync(join(profile.root, "firefly-chats", "sessions"), { recursive: true }); fs.writeFileSync(indexPath(), text); }
const message = (id: string, content: string, role: "user" | "model" = "user") => ({ id, content, role, at: 17 });
async function ready() { const store = await import("./chats-store"); store.initialize(); return store; }
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
        const { ephemeralConversations } = await import("../ephemeral-conversations");
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
