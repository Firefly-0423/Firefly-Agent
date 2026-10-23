import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createActiveChatTargetRegistry } from "../plugin-host/active-chat-target";
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
});
