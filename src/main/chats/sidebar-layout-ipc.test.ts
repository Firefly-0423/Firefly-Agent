import { expect, it, vi } from "vitest";
import { registerSidebarLayoutIpc } from "./sidebar-layout-ipc";
import { SIDEBAR_LAYOUT_IPC, type SidebarSnapshot } from "../../shared/sidebar-layout";

function fixture() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const sender = { mainFrame: {}, isDestroyed: () => false }, foreign = { mainFrame: {} };
  const event = { sender, senderFrame: sender.mainFrame };
  const snapshot = { layout: { revision: 0 } } as SidebarSnapshot;
  const store = { getSnapshot: vi.fn(() => snapshot), applyPatch: vi.fn(() => ({ ok: true as const, snapshot })) };
  const changed = vi.fn();
  registerSidebarLayoutIpc({ handle: (channel, callback) => { handlers.set(channel, callback); } }, {
    store, getChatContents: () => sender as never, onChanged: changed,
  });
  return { handlers, event, foreign, store, snapshot, changed };
}

it.each(["foreign", "subframe", "missing-frame"])("rejects %s before reading or mutating layout", kind => {
  const f = fixture();
  const event = kind === "foreign" ? { sender: f.foreign, senderFrame: f.foreign.mainFrame }
    : { ...f.event, senderFrame: kind === "subframe" ? {} : null };
  expect(f.handlers.get(SIDEBAR_LAYOUT_IPC.get)!(event)).toMatchObject({ ok: false, code: "owner_mismatch" });
  expect(f.handlers.get(SIDEBAR_LAYOUT_IPC.mutate)!(event, {})).toMatchObject({ ok: false, code: "owner_mismatch" });
  expect(f.store.getSnapshot).not.toHaveBeenCalled();
  expect(f.store.applyPatch).not.toHaveBeenCalled();
  expect(f.changed).not.toHaveBeenCalled();
});

it("returns the native-owned snapshot and broadcasts only successful changes", () => {
  const f = fixture();
  expect(f.handlers.get(SIDEBAR_LAYOUT_IPC.get)!(f.event)).toEqual({ ok: true, snapshot: f.snapshot });
  const mutation = { expectedRevision: 0, patch: { mode: "work", kind: "set-sort", sortMode: "manual" } };
  expect(f.handlers.get(SIDEBAR_LAYOUT_IPC.mutate)!(f.event, mutation)).toEqual({ ok: true, snapshot: f.snapshot });
  expect(f.store.applyPatch).toHaveBeenCalledWith(mutation);
  expect(f.changed).toHaveBeenCalledTimes(1);
  f.store.applyPatch.mockReturnValueOnce({ ok: false, code: "conflict" } as never);
  expect(f.handlers.get(SIDEBAR_LAYOUT_IPC.mutate)!(f.event, mutation)).toEqual({ ok: false, code: "conflict" });
  expect(f.changed).toHaveBeenCalledTimes(1);
});

it("reports unreadable storage without substituting a default layout", () => {
  const f = fixture(); f.store.getSnapshot.mockImplementationOnce(() => { throw Error("fixture corrupt"); });
  expect(f.handlers.get(SIDEBAR_LAYOUT_IPC.get)!(f.event)).toEqual({ ok: false, code: "storage_error" });
});
