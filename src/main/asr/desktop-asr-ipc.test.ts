import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { registerDesktopAsrIpc } from "./desktop-asr-ipc";
import { IPC } from "../../shared/ipc-channels";
class Contents extends EventEmitter { id = 7; mainFrame = {}; isDestroyed() { return false; } }
it("authorizes only the current ChatWindow main frame for every operation", async () => {
  const owner = new Contents(); const other = new Contents(); let current: Contents | null = owner;
  const handlers = new Map<string, (...args: any[]) => any>(); const calls: string[] = [];
  const service = { start: async () => { calls.push("start"); return { ok: true }; }, frame: () => { calls.push("frame"); return { ok: true }; }, stop: async () => { calls.push("stop"); return { ok: true }; }, cancel: () => { calls.push("cancel"); return { ok: true }; }, cancelOwner: () => {}, cancelAll: () => {}, dispose: () => {} };
  const bridge = registerDesktopAsrIpc({ ipc: { handle: (key, fn) => { handlers.set(key, fn); } }, getChatContents: () => current as never, service: service as never });
  for (const channel of [IPC.DESKTOP_ASR_START, IPC.DESKTOP_ASR_FRAME, IPC.DESKTOP_ASR_STOP, IPC.DESKTOP_ASR_CANCEL]) {
    for (const event of [{ sender: other, senderFrame: other.mainFrame }, { sender: owner, senderFrame: {} }, { sender: owner, senderFrame: null }]) expect(await handlers.get(channel)!(event, "fixture-recording-01")).toEqual({ ok: false, code: "forbidden" });
  }
  expect(calls).toEqual([]);
  await handlers.get(IPC.DESKTOP_ASR_START)!({ sender: owner, senderFrame: owner.mainFrame }, "fixture-recording-01"); expect(calls).toEqual(["start"]);
  current = null;
  expect(await handlers.get(IPC.DESKTOP_ASR_STOP)!({ sender: owner, senderFrame: owner.mainFrame }, "fixture-recording-01")).toEqual({ ok: false, code: "forbidden" }); bridge.dispose();
});
it("cancels on main navigation, render loss, destruction, target change and shutdown", async () => {
  const owner = new Contents(); const cancelled: number[] = []; let all = 0; let disposed = 0;
  const handlers = new Map<string, (...args: any[]) => any>();
  const bridge = registerDesktopAsrIpc({ ipc: { handle: (key, fn) => { handlers.set(key, fn); } }, getChatContents: () => owner as never,
    service: { start: async () => ({ ok: true }), cancelOwner: (id: number) => cancelled.push(id), cancelAll: () => { all++; }, dispose: () => { disposed++; } } as never });
  await handlers.get(IPC.DESKTOP_ASR_START)!({ sender: owner, senderFrame: owner.mainFrame }, "fixture-recording-01");
  owner.emit("did-start-navigation", { isMainFrame: false }); expect(cancelled).toEqual([]);
  owner.emit("did-start-navigation", { isMainFrame: true }); owner.emit("render-process-gone"); owner.emit("destroyed");
  expect(cancelled).toEqual([7, 7, 7]); expect(owner.listenerCount("did-start-navigation")).toBe(0);
  bridge.cancelAll(); expect(all).toBe(1); bridge.dispose(); expect(disposed).toBe(1);
});
