import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ binding: undefined as { workspaceRoot: string; boundAt: number } | undefined, confirm: vi.fn(), discard: vi.fn(), window: undefined as any }));
vi.mock("./chats-store", () => ({ getWorkspaceBinding: () => mocks.binding }));
vi.mock("electron", () => ({ ipcMain: {}, BrowserWindow: { fromWebContents: () => mocks.window }, dialog: { showMessageBox: mocks.confirm, showMessageBoxSync: mocks.discard } }));
import { registerWorkspaceFilesIpc, readFile } from "./workspace-files-ipc";
import { IPC } from "../../shared/ipc-channels";
class Contents extends EventEmitter { id = 99; mainFrame = {}; isDestroyed() { return false; } }
let registration: ReturnType<typeof registerWorkspaceFilesIpc>;
let root: string; let owner: Contents; let handlers: Map<string, (...args: any[]) => any>;
beforeEach(() => {
 root = fs.mkdtempSync(path.join(tmpdir(), "firefly-editor-ipc-")); fs.writeFileSync(path.join(root, "text.txt"), "before"); mocks.binding = { workspaceRoot: root, boundAt: 1 }; mocks.confirm.mockReset().mockResolvedValue({ response: 1 }); mocks.discard.mockReset().mockReturnValue(0); owner = new Contents(); handlers = new Map();
 mocks.window = new EventEmitter(); mocks.window.destroyed = false; mocks.window.isDestroyed = () => mocks.window.destroyed;
 mocks.window.close = vi.fn(() => { const unload = { preventDefault: () => { mocks.window.destroyed = true; mocks.window.emit("closed"); } }; owner.emit("will-prevent-unload", unload); });
 registration = registerWorkspaceFilesIpc({ handle: (channel, fn) => { handlers.set(channel, fn); } } as never, { getChatContents: () => owner as never });
});
afterEach(() => { vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });
async function request() { const snapshot = await readFile(root, "text.txt"); return { sessionId: "s", relPath: "text.txt", content: "after", editVersion: snapshot.ok ? snapshot.editVersion : "" }; }
it("read yields a complete editable snapshot and save requires the current ChatWindow main frame", async () => {
 const payload = await request(); expect(payload.editVersion).toMatch(/^[a-f0-9]{64}$/); const handler = handlers.get(IPC.WORKSPACE_FILES_SAVE)!;
 for (const event of [{ sender: new Contents(), senderFrame: owner.mainFrame }, { sender: owner, senderFrame: {} }, { sender: owner, senderFrame: null }]) expect(await handler(event, payload)).toEqual({ ok: false, code: "FORBIDDEN" });
 expect(mocks.confirm).not.toHaveBeenCalled(); expect(fs.readFileSync(path.join(root, "text.txt"), "utf8")).toBe("before");
 expect(await handler({ sender: owner, senderFrame: owner.mainFrame }, payload)).toMatchObject({ ok: true, content: "after" });
 expect(mocks.confirm.mock.calls[0][1]).toMatchObject({ cancelId: 0, defaultId: 0 });
});
it("lists and reads only for the ChatWindow main frame, not for other windows, guest pages or subframes", async () => {
 const list = handlers.get(IPC.WORKSPACE_FILES_LIST)!, read = handlers.get(IPC.WORKSPACE_FILES_READ)!;
 const foreign = [{ sender: new Contents(), senderFrame: owner.mainFrame }, { sender: owner, senderFrame: {} }, { sender: owner, senderFrame: null }, { sender: undefined, senderFrame: undefined }];
 for (const event of foreign) {
  expect(await list(event, { sessionId: "s", relPath: "" })).toEqual({ ok: false, code: "FORBIDDEN" });
  expect(await read(event, { sessionId: "s", relPath: "text.txt" })).toEqual({ ok: false, code: "FORBIDDEN" });
 }
 const trusted = { sender: owner, senderFrame: owner.mainFrame };
 expect(await list(trusted, { sessionId: "s", relPath: "" })).toMatchObject({ ok: true });
 expect(await read(trusted, { sessionId: "s", relPath: "text.txt" })).toMatchObject({ ok: true });
 // 被拒绝的调用方不应触发未保存草稿保护的挂接。
 expect(owner.listenerCount("will-prevent-unload")).toBe(1);
});
it("navigation while the native save dialog is open invalidates approval", async () => {
 mocks.confirm.mockImplementation(async () => { owner.emit("did-start-navigation", { isMainFrame: true }); return { response: 1 }; });
 expect(await handlers.get(IPC.WORKSPACE_FILES_SAVE)!({ sender: owner, senderFrame: owner.mainFrame }, await request())).toEqual({ ok: false, code: "FORBIDDEN" });
 expect(fs.readFileSync(path.join(root, "text.txt"), "utf8")).toBe("before"); expect(owner.listenerCount("did-start-navigation")).toBe(0);
});
it("unsupported encoding is preview-only and cannot acquire an edit version", async () => {
 fs.writeFileSync(path.join(root, "text.txt"), Buffer.from([0xc3, 0x28]));
 expect(await readFile(root, "text.txt")).toMatchObject({ ok: true, readOnlyReason: "UNSUPPORTED_TEXT" }); expect((await request()).editVersion).toBeUndefined();
});

it("native unload confirmation keeps drafts unless the user explicitly discards them", async () => {
 const event = { sender: owner, senderFrame: owner.mainFrame };
 await handlers.get(IPC.WORKSPACE_FILES_READ)!(event, { sessionId: "s", relPath: "text.txt" });
 const keep = { preventDefault: vi.fn() }; owner.emit("will-prevent-unload", keep); expect(mocks.discard).toHaveBeenCalledOnce(); expect(keep.preventDefault).not.toHaveBeenCalled();
 mocks.discard.mockReturnValue(1); const discard = { preventDefault: vi.fn() }; owner.emit("will-prevent-unload", discard); expect(discard.preventDefault).toHaveBeenCalledOnce();
 owner.emit("destroyed"); expect(owner.listenerCount("will-prevent-unload")).toBe(0);
});

it("cancels shutdown before closing and leaves the save IPC usable", async () => {
 await handlers.get(IPC.WORKSPACE_FILES_READ)!({ sender: owner, senderFrame: owner.mainFrame }, { sessionId: "s", relPath: "text.txt" });
 expect(await registration.confirmBeforeShutdown()).toBe(false); expect(mocks.window.destroyed).toBe(false); expect(mocks.window.listenerCount("closed")).toBe(0);
 expect(await handlers.get(IPC.WORKSPACE_FILES_SAVE)!({ sender: owner, senderFrame: owner.mainFrame }, await request())).toMatchObject({ ok: true, content: "after" });
 mocks.discard.mockReturnValue(1); expect(await registration.confirmBeforeShutdown()).toBe(true); expect(mocks.window.destroyed).toBe(true); expect(mocks.window.listenerCount("closed")).toBe(0);
});
it("waits for actual close, deduplicates pending preflights, and cleans up after timeout", async () => {
 vi.useFakeTimers(); mocks.window.close.mockImplementation(() => {});
 const first = registration.confirmBeforeShutdown(); const second = registration.confirmBeforeShutdown(); expect(mocks.window.close).toHaveBeenCalledOnce();
 await vi.advanceTimersByTimeAsync(5000); expect(await first).toBe(false); expect(await second).toBe(false); expect(mocks.window.listenerCount("closed")).toBe(0);
 mocks.window.close.mockImplementation(() => { mocks.window.destroyed = true; mocks.window.emit("closed"); }); expect(await registration.confirmBeforeShutdown()).toBe(true);
});
it("cancels shutdown if saving is pending and never closes that window", async () => {
 let resolve!: (value: { response: number }) => void; mocks.confirm.mockImplementation(() => new Promise(done => { resolve = done; }));
 const saving = handlers.get(IPC.WORKSPACE_FILES_SAVE)!({ sender: owner, senderFrame: owner.mainFrame }, await request());
 expect(await registration.confirmBeforeShutdown()).toBe(false); expect(mocks.window.close).not.toHaveBeenCalled(); resolve({ response: 0 }); await saving;
});
