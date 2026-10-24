import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { createExternalSkillService } from "./external-service";
import type { ExternalOwner } from "./external-types";
const modules = import.meta.glob<typeof import("./external-ipc")>("./external-ipc.ts");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanups.splice(0)) await dispose(); });
function contents(id = 1) { return Object.assign(new EventEmitter(), { id, mainFrame: { processId: 10 + id, routingId: 20 + id, detached: false }, isDestroyed: vi.fn(() => false) }); }
async function setup() {
  const load = modules["./external-ipc.ts"]; expect(load, "Trusted external-Skill Main IPC registration must exist").toBeTypeOf("function");
  let host: ReturnType<typeof contents> | null = contents(); const original = host;
  const handlers = new Map<string, (...args: any[]) => unknown>(); const ok = { ok: true, value: [] };
  const service = { list: vi.fn(async () => ok), detail: vi.fn(async () => ok), prepare: vi.fn(async () => ok), commit: vi.fn(async () => ok), cancel: vi.fn(async () => ok), invalidate: vi.fn(), dispose: vi.fn(async () => {}) };
  const binding = (await load()).registerExternalSkillsIpc({ ipc: { handle: (channel, handler) => { handlers.set(channel, handler); } }, getHostWebContents: () => host as unknown as WebContents | null, service: service as unknown as ReturnType<typeof createExternalSkillService> });
  cleanups.push(() => binding.dispose()); const event = (sender = host!) => ({ sender, senderFrame: sender.mainFrame });
  const invoke = async (method: string, payload: unknown, ev = event()) => handlers.get("external-skills:" + method)!(ev, payload);
  return { original, handlers, service, binding, event, invoke, host: () => host, replace: (next: ReturnType<typeof contents> | null) => { host = next; binding.refreshHost(); } };
}
const requests = [["list", { sourceId: "openai" }], ["detail", { sourceId: "openai", id: "external-openai-test" }], ["prepare", { sourceId: "openai", id: "external-openai-test" }], ["commit", { token: "a".repeat(64) }], ["cancel", {}]] as const;
it("trusted_main_frame_only registers exactly five handlers and derives owner from real event", async () => {
  const f = await setup(); expect([...f.handlers.keys()]).toEqual(requests.map(([method]) => "external-skills:" + method));
  for (const [method, payload] of requests) { expect(await f.invoke(method, payload)).toMatchObject({ ok: true }); const call = f.service[method].mock.calls[0] as unknown as unknown[]; expect(call[0]).toEqual({ webContentsId: 1, frameProcessId: 11, frameRoutingId: 21, generation: 0 }); }
  expect(f.service.list).toHaveBeenCalledWith(expect.any(Object), "openai", false); await f.invoke("list", { sourceId: "anthropic", refresh: true }); expect(f.service.list).toHaveBeenLastCalledWith(expect.any(Object), "anthropic", true);
});
it.each(["no-owner", "destroyed", "other-window", "subframe", "old-frame"])("trusted_main_frame_only rejects %s for every method without service dispatch", async kind => {
  const f = await setup(); let event: any = f.event();
  if (kind === "no-owner") f.replace(null); if (kind === "destroyed") f.original.isDestroyed.mockReturnValue(true); if (kind === "other-window") event = f.event(contents(9));
  if (kind === "subframe") event.senderFrame = { processId: 11, routingId: 22, detached: false }; if (kind === "old-frame") { event = f.event(); f.original.mainFrame = { processId: 99, routingId: 99, detached: false }; }
  for (const [method, payload] of requests) { expect(await f.invoke(method, payload, event)).toMatchObject({ ok: false, code: "FORBIDDEN" }); expect(f.service[method]).not.toHaveBeenCalled(); }
});
it.each(["url", "path", "hash", "target"])("payload whitelist rejects extra %s on every channel", async key => { const f = await setup(); for (const [method, payload] of requests) { expect(await f.invoke(method, { ...payload, [key]: "untrusted" })).toMatchObject({ ok: false }); expect(f.service[method]).not.toHaveBeenCalled(); } });
it.each([null, [], "openai", {}, { sourceId: "other" }, { sourceId: "openai", refresh: "true" }])("payload validation rejects malformed list %j", async payload => { const f = await setup(); expect(await f.invoke("list", payload)).toMatchObject({ ok: false }); expect(f.service.list).not.toHaveBeenCalled(); });
it("lifecycle_invalidation ignores subframe navigation, invalidates main navigation and rejects old in-flight document", async () => {
  const f = await setup(); await f.invoke("prepare", requests[2][1]); const owner = (f.service.prepare.mock.calls[0] as unknown as [ExternalOwner])[0];
  f.original.emit("did-start-navigation", {}, "file://test", false, false, 11, 22); expect(f.service.invalidate).not.toHaveBeenCalled();
  f.original.emit("did-start-navigation", {}, "file://test", false, true, 11, 21); expect(f.service.invalidate).toHaveBeenCalledWith(owner); expect(await f.invoke("commit", requests[3][1])).toMatchObject({ code: "FORBIDDEN" });
  f.original.mainFrame = { processId: 12, routingId: 24, detached: false }; f.original.emit("did-navigate", {}, "file://test"); await f.invoke("list", requests[0][1]); expect(f.service.list).toHaveBeenLastCalledWith({ webContentsId: 1, frameProcessId: 12, frameRoutingId: 24, generation: 1 }, "openai", false);
});
it.each(["render-process-gone", "destroyed"])("lifecycle_invalidation %s revokes owner and releases every listener", async cause => { const f = await setup(); await f.invoke("prepare", requests[2][1]); f.original.emit(cause, {}, {}); expect(f.service.invalidate).toHaveBeenCalledOnce(); expect(await f.invoke("list", requests[0][1])).toMatchObject({ code: "FORBIDDEN" }); f.replace(contents(2)); expect(await f.invoke("list", requests[0][1])).toMatchObject({ ok: true }); expect(f.original.eventNames()).toEqual([]); });
it("lifecycle_invalidation replacement happens before another request, rebinds new owner and disposal awaits terminal service", async () => {
  const f = await setup(); await f.invoke("prepare", requests[2][1]); f.replace(contents(2)); expect(f.service.invalidate).toHaveBeenCalledOnce(); expect(f.original.eventNames()).toEqual([]);
  const next = f.host()!; expect(next.listenerCount("did-start-navigation")).toBe(1); await f.invoke("list", requests[0][1]); expect(f.service.list).toHaveBeenLastCalledWith({ webContentsId: 2, frameProcessId: 12, frameRoutingId: 22, generation: 1 }, "openai", false);
  let release!: () => void; f.service.dispose.mockImplementation(() => new Promise<void>(resolve => { release = resolve; })); let finished = false; const disposing = f.binding.dispose().then(() => { finished = true; }); await Promise.resolve(); expect(finished).toBe(false); expect(next.eventNames()).toEqual([]); expect(await f.invoke("list", requests[0][1])).toMatchObject({ code: "FORBIDDEN" }); release(); await disposing; await f.binding.dispose(); expect(f.service.dispose).toHaveBeenCalledOnce();
});

it("lifecycle_invalidation Electron 43 details and same-document history navigation revoke approval", async () => {
  const f = await setup(); await f.invoke("prepare", requests[2][1]); f.original.emit("did-start-navigation", { isMainFrame: false, isSameDocument: true }); expect(f.service.invalidate).not.toHaveBeenCalled();
  f.original.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true }); expect(f.service.invalidate).toHaveBeenCalledOnce(); expect(await f.invoke("commit", requests[3][1])).toMatchObject({ code: "FORBIDDEN" });
  f.original.emit("did-navigate-in-page", {}, "file://test#next", false); expect(await f.invoke("list", requests[0][1])).toMatchObject({ code: "FORBIDDEN" });
  f.original.emit("did-navigate-in-page", {}, "file://test#next", true); expect(await f.invoke("list", requests[0][1])).toMatchObject({ ok: true });
});
it("trusted_main_frame_only rejects detached current frames and missing event", async () => { const f = await setup(); f.original.mainFrame.detached = true; expect(await f.invoke("list", requests[0][1])).toMatchObject({ code: "FORBIDDEN" }); expect(await f.handlers.get("external-skills:list")!(undefined, requests[0][1])).toMatchObject({ code: "FORBIDDEN" }); expect(f.service.list).not.toHaveBeenCalled(); });

it.each(["detail", "prepare"] as const)("revision selection crosses %s only as validated kind and expected commit", async method => {
  const f = await setup(), selection = { kind: "reviewed", commit: "a".repeat(40) };
  expect(await f.invoke(method, { sourceId: "openai", id: "external-openai-test", selection })).toMatchObject({ ok: true });
  expect(f.service[method]).toHaveBeenCalledExactlyOnceWith(expect.any(Object), "openai", "external-openai-test", selection);
});
it.each([null, [], {}, { kind: "pinned", commit: "a".repeat(40) }, { kind: "latest", commit: "main" }, { kind: "reviewed", commit: "a".repeat(40), policyVersion: "forged" }, { kind: "reviewed", commit: "a".repeat(40), path: "skills/other" }])("revision IPC rejects malformed or expanded authority %j", async selection => {
  const f = await setup();
  for (const method of ["detail", "prepare"] as const) {
    expect(await f.invoke(method, { sourceId: "openai", id: "external-openai-test", selection })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(f.service[method]).not.toHaveBeenCalled();
  }
});
