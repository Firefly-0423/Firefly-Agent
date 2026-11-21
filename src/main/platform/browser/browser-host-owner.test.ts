import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createActiveChatTargetRegistry } from "../interaction/active-chat-target";
import { createBrowserService, type BrowserHostPort } from "./browser-service";
import { registerBrowserHostOwner } from "./browser-host-owner";
import type { WebContents } from "electron";

describe("native host owner from the existing Main active target and real session lookup", () => {
  it("mints a stable private owner and synchronously aborts it on refresh/session switch", () => {
    const targets = createActiveChatTargetRegistry(), frame = {}, contents = Object.assign(new EventEmitter(), { id: 2, mainFrame: frame, isDestroyed: () => false });
    const host: BrowserHostPort = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false, isVisible: () => true, isFocused: () => true, getContentSize: (): [number, number] => [800,600], contentView: { addChildView: () => {}, removeChildView: () => {} } });
    const profile = {}, service = createBrowserService({ profile, createSession: () => { throw Error("gate closed"); }, createView: () => { throw Error("gate closed"); } });
    const binding = registerBrowserHostOwner({ host, profile, targets, service, readSession: id => ({ id, mode: "chat" }) });
    targets.setActive({ sender: contents as unknown as WebContents, sessionId: "a", mode: "chat", rendererTargetId: "renderer" }); binding.refresh();
    const owner = binding.resolveOwner({ sender: contents, senderFrame: frame }); expect(owner?.conversationId).toBe("a"); expect(owner?.profile).toBe(profile); expect(owner?.topFrame).toBe(frame);
    expect(binding.resolveOwner({ sender: contents, senderFrame: frame })).toBe(owner);
    expect((binding as any).getCurrentOwner).toBeTypeOf("function"); expect((binding as any).getCurrentOwner()).toBe(owner);
    expect(binding.resolveOwner({ sender: contents, senderFrame: {} })).toBeNull();
    targets.setActive({ sender: contents as unknown as WebContents, sessionId: "b", mode: "chat", rendererTargetId: "renderer" }); binding.refresh();
    expect(owner?.signal.aborted).toBe(true); const next = binding.resolveOwner({ sender: contents, senderFrame: frame }); expect(next?.conversationId).toBe("b"); expect(next?.generation).toBeGreaterThan(owner?.generation ?? 0); expect(next?.ownerSessionId).not.toBe(owner?.ownerSessionId);
    binding.dispose(); targets.dispose();
  });
  it("requires an existing mode-matched session, exact host and current Main target", () => {
    const targets = createActiveChatTargetRegistry(), frame = {}, contents = Object.assign(new EventEmitter(), { id: 3, mainFrame: frame, isDestroyed: () => false });
    const host: BrowserHostPort = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false, isVisible: () => true, isFocused: () => true, getContentSize: (): [number, number] => [800,600], contentView: { addChildView: () => {}, removeChildView: () => {} } });
    const profile = {}, service = createBrowserService({ profile, createSession: () => { throw Error("gate closed"); }, createView: () => { throw Error("gate closed"); } });
    const binding = registerBrowserHostOwner({ host, profile, targets, service, readSession: id => id === "exists" ? { id, mode: "code" } : null });
    for (const [id,mode] of [["missing","chat"],["exists","chat"]] as const) { targets.setActive({ sender: contents as unknown as WebContents, sessionId: id, mode, rendererTargetId: "r" }); binding.refresh(); expect(binding.resolveOwner({ sender: contents, senderFrame: frame })).toBeNull(); }
    targets.setActive({ sender: contents as unknown as WebContents, sessionId: "exists", mode: "code", rendererTargetId: "r" }); binding.refresh();
    const owner = binding.resolveOwner({ sender: contents, senderFrame: frame }); expect(owner).not.toBeNull();
    targets.notifySessionDeleted("exists"); expect(owner?.signal.aborted).toBe(true); expect(binding.resolveOwner({ sender: contents, senderFrame: frame })).toBeNull();
    binding.dispose(); targets.dispose();
  });
  it("invalidates the owner when native destruction makes host properties unavailable", () => {
    let destroyed = false;
    const targets = createActiveChatTargetRegistry(), frame = {}, contents = Object.assign(new EventEmitter(), {
      mainFrame: frame, isDestroyed: () => destroyed,
    });
    Object.defineProperty(contents, "id", { get: () => { if (destroyed) throw Error("Object has been destroyed"); return 4; } });
    const host: BrowserHostPort = Object.assign(new EventEmitter(), { webContents: contents as typeof contents & { id: number },
      isDestroyed: () => destroyed, isVisible: () => false, isFocused: () => false,
      getContentSize: (): [number, number] => [800, 600], contentView: { addChildView: () => {}, removeChildView: () => {} } });
    const profile = {}, service = createBrowserService({ profile, createSession: () => { throw Error("gate closed"); }, createView: () => { throw Error("gate closed"); } });
    const binding = registerBrowserHostOwner({ host, profile, targets, service, readSession: id => ({ id, mode: "chat" }) });
    targets.setActive({ sender: contents as unknown as WebContents, sessionId: "a", mode: "chat", rendererTargetId: "r" }); binding.refresh();
    const owner = binding.resolveOwner({ sender: contents as typeof contents & { id: number }, senderFrame: frame });
    expect(owner).not.toBeNull(); expect(owner?.signal.aborted).toBe(false);
    destroyed = true; contents.emit("destroyed");
    expect(owner?.signal.aborted).toBe(true);
    binding.dispose(); targets.dispose();
  });

  it("splits BrowserRunLease from PageOwner: preserves lease across switch/refresh, blocks stale promotion and resurrection", async () => {
    const targets = createActiveChatTargetRegistry(), frame = {}, contents = Object.assign(new EventEmitter(), { id: 5, mainFrame: frame, isDestroyed: () => false });
    const host: BrowserHostPort = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false, isVisible: () => true, isFocused: () => true, getContentSize: (): [number, number] => [800, 600], contentView: { addChildView: () => {}, removeChildView: () => {} } });
    const profile = {};
    const service = createBrowserService({
      profile,
      gateOpen: true,
      createSession: () => { throw Error("unused"); },
      createView: () => { throw Error("unused"); },
    });
    let sessionValid = true, runActive = true;
    const binding = registerBrowserHostOwner({
      host, profile, targets, service,
      readSession: id => ({ id, mode: "work" }),
      validateSession: () => sessionValid,
      isRunActive: (_cid, rid) => runActive && rid === "run-1",
    });
    targets.setActive({ sender: contents as unknown as WebContents, sessionId: "a", mode: "work", rendererTargetId: "r1" });
    binding.refresh();
    const pageOwnerA = binding.resolveOwner({ sender: contents, senderFrame: frame })!;
    expect(pageOwnerA.conversationId).toBe("a");
    // Prime service with pageOwnerA via get
    expect(await service.dispatch({ sender: contents, senderFrame: frame }, { kind: "get" })).toEqual({ ok: true, value: null });

    // Retain run lease from valid PageOwner
    const lease = binding.retainRunLease(pageOwnerA, { conversationId: "a", runId: "run-1" });
    expect(lease).not.toBeNull();
    expect(lease!.signal.aborted).toBe(false);
    expect(lease!.isCurrent()).toBe(true);
    // Same {conversationId, runId} cannot be double-activated
    expect(binding.retainRunLease(pageOwnerA, { conversationId: "a", runId: "run-1" })).toBeNull();
    expect(binding.getRunLease("a", "run-1")).toBe(lease);

    // Switch session a -> b: PageOwner aborts, but BrowserRunLease stays alive
    targets.setActive({ sender: contents as unknown as WebContents, sessionId: "b", mode: "work", rendererTargetId: "r1" });
    binding.refresh();
    expect(pageOwnerA.signal.aborted).toBe(true);
    expect(lease!.signal.aborted).toBe(false);
    expect(lease!.isCurrent()).toBe(true);

    // Stale/aborted PageOwner cannot mint a new lease
    expect(binding.retainRunLease(pageOwnerA, { conversationId: "a", runId: "run-2" })).toBeNull();

    // Main-frame navigation/refresh invalidation aborts PageOwner but preserves BrowserRunLease
    contents.emit("did-start-navigation", {}, "https://app.local/", false, true);
    expect(lease!.signal.aborted).toBe(false);
    expect(lease!.isCurrent()).toBe(true);

    // Release lease -> cannot be resurrected for same {conversationId, runId} even on fresh PageOwner
    targets.setActive({ sender: contents as unknown as WebContents, sessionId: "a", mode: "work", rendererTargetId: "r2" });
    binding.refresh();
    const freshOwnerA = binding.resolveOwner({ sender: contents, senderFrame: frame })!;
    expect(await service.dispatch({ sender: contents, senderFrame: frame }, { kind: "get" })).toEqual({ ok: true, value: null });
    binding.releaseRunLease("a", "run-1");
    expect(lease!.signal.aborted).toBe(true);
    expect(lease!.isCurrent()).toBe(false);
    expect(binding.retainRunLease(freshOwnerA, { conversationId: "a", runId: "run-1" })).toBeNull();
    binding.dispose(); targets.dispose();
  });

  it("aborts an active BrowserRunLease immediately on session deletion or failed session validation", async () => {
    const targets = createActiveChatTargetRegistry(), frame = {}, contents = Object.assign(new EventEmitter(), { id: 7, mainFrame: frame, isDestroyed: () => false });
    const host: BrowserHostPort = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false, isVisible: () => true, isFocused: () => true, getContentSize: (): [number, number] => [800, 600], contentView: { addChildView: () => {}, removeChildView: () => {} } });
    const profile = {};
    const service = createBrowserService({
      profile, gateOpen: true,
      createSession: () => { throw Error("unused"); },
      createView: () => { throw Error("unused"); },
    });
    let valid = true;
    const binding = registerBrowserHostOwner({
      host, profile, targets, service,
      readSession: id => ({ id, mode: "work" }),
      validateSession: () => valid,
      isRunActive: () => true,
    });
    targets.setActive({ sender: contents as unknown as WebContents, sessionId: "s1", mode: "work", rendererTargetId: "r1" });
    binding.refresh();
    const owner1 = binding.resolveOwner({ sender: contents, senderFrame: frame })!;
    await service.dispatch({ sender: contents, senderFrame: frame }, { kind: "get" });
    const lease1 = binding.retainRunLease(owner1, { conversationId: "s1", runId: "r1" })!;
    expect(lease1.isCurrent()).toBe(true);
    targets.notifySessionDeleted("s1");
    expect(lease1.signal.aborted).toBe(true);
    expect(lease1.isCurrent()).toBe(false);

    targets.setActive({ sender: contents as unknown as WebContents, sessionId: "s2", mode: "work", rendererTargetId: "r1" });
    binding.refresh();
    const owner2 = binding.resolveOwner({ sender: contents, senderFrame: frame })!;
    await service.dispatch({ sender: contents, senderFrame: frame }, { kind: "get" });
    const lease2 = binding.retainRunLease(owner2, { conversationId: "s2", runId: "r2" })!;
    expect(lease2.isCurrent()).toBe(true);
    valid = false;
    expect(lease2.isCurrent()).toBe(false);
    expect(lease2.signal.aborted).toBe(true);
    binding.dispose(); targets.dispose();
  });
});
