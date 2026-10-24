import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createActiveChatTargetRegistry } from "../plugin-host/active-chat-target";
import { createBrowserService, type BrowserHostPort } from "./browser-service";
import { registerManualBrowserHostOwner } from "./browser-host-owner";
import type { WebContents } from "electron";

function fixture() {
  let destroyed = false;
  const frame = {}, contents = Object.assign(new EventEmitter(), { id: 31, mainFrame: frame, isDestroyed: () => destroyed });
  const host: BrowserHostPort = Object.assign(new EventEmitter(), { webContents: contents,
    isDestroyed: () => destroyed, isVisible: () => true, isFocused: () => true,
    getContentSize: () => [800, 600], contentView: { addChildView: () => {}, removeChildView: () => {} } });
  const profile = {}, service = createBrowserService({ profile,
    createSession: () => { throw Error("closed gate"); }, createView: () => { throw Error("closed gate"); } });
  expect(registerManualBrowserHostOwner).toBeTypeOf("function");
  const binding = registerManualBrowserHostOwner({ host, profile, service });
  return { contents, host, profile, service, binding, frame, destroy() { destroyed = true; contents.emit("destroyed"); } };
}

describe("window-owned manual browser identity", () => {
  it("exists without a conversation and survives session, mode, clear and deletion", () => {
    const f = fixture(), targets = createActiveChatTargetRegistry();
    const owner = f.binding.resolveOwner({ sender: f.contents, senderFrame: f.frame });
    expect(owner).toMatchObject({ host: f.host, profile: f.profile, topFrame: f.frame, conversationId: null });
    expect(owner?.workspaceId).toBeTypeOf("string");
    for (const mode of ["chat", "work", "code"] as const) {
      targets.setActive({ sender: f.contents as unknown as WebContents, sessionId: mode, mode, rendererTargetId: "renderer" });
      expect(f.binding.getCurrentOwner()).toBe(owner);
    }
    targets.clearActive(f.contents as unknown as WebContents); targets.notifySessionDeleted("code");
    expect(f.binding.getCurrentOwner()).toBe(owner); expect(owner?.signal.aborted).toBe(false);
    f.binding.dispose(); targets.dispose();
  });
  it("requires the exact native host frame and replaces its epoch after host navigation", () => {
    const f = fixture(), owner = f.binding.getCurrentOwner();
    expect(f.binding.resolveOwner({ sender: f.contents, senderFrame: {} })).toBeNull();
    expect(f.binding.resolveOwner({ sender: { ...f.contents }, senderFrame: f.frame })).toBeNull();
    f.contents.emit("did-start-navigation", {}, "https://untrusted.example/", false, false);
    expect(f.binding.getCurrentOwner()).toBe(owner);
    f.contents.emit("did-start-navigation", {}, "file:///host", false, true);
    expect(owner?.signal.aborted).toBe(true);
    expect(f.binding.getCurrentOwner()).toBeNull();
    f.contents.mainFrame = {};
    f.contents.emit("did-finish-load");
    const next = f.binding.resolveOwner({ sender: f.contents, senderFrame: f.contents.mainFrame });
    expect(next?.workspaceId).not.toBe(owner?.workspaceId); expect(next?.generation).toBeGreaterThan(owner?.generation ?? -1);
    f.binding.dispose();
  });
  it("detaches only on hide and blur, and revokes permanently on native destruction", () => {
    const f = fixture(), owner = f.binding.getCurrentOwner();
    (f.host as unknown as EventEmitter).emit("hide"); (f.host as unknown as EventEmitter).emit("blur");
    expect(f.binding.getCurrentOwner()).toBe(owner); expect(owner?.signal.aborted).toBe(false);
    f.destroy(); expect(owner?.signal.aborted).toBe(true); expect(f.binding.getCurrentOwner()).toBeNull();
    f.binding.dispose(); expect(f.contents.listenerCount("did-start-navigation")).toBe(0);
  });
});

it("revokes on main-frame navigation reported only through the details argument", () => {
  const f = fixture(), owner = f.binding.getCurrentOwner();
  f.contents.emit("did-start-navigation", { url: "https://untrusted.example/", isMainFrame: false, isSameDocument: false });
  f.contents.emit("did-start-navigation", { url: "file:///host#x", isMainFrame: true, isSameDocument: true });
  expect(f.binding.getCurrentOwner()).toBe(owner);
  f.contents.emit("did-start-navigation", { url: "file:///host", isMainFrame: true, isSameDocument: false });
  expect(owner?.signal.aborted).toBe(true); expect(f.binding.getCurrentOwner()).toBeNull();
  f.binding.dispose();
});

it("characterizes a failed main-frame load: authority stays revoked until a later finished load", () => {
  const f = fixture(), owner = f.binding.getCurrentOwner();
  f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  f.contents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "file:///host", true);
  expect(owner?.signal.aborted).toBe(true);
  // Reproduces issue 2: no did-finish-load follows a failed load, so the workspace stays unavailable.
  expect(f.binding.resolveOwner({ sender: f.contents, senderFrame: f.frame })).toBeNull();
  f.contents.emit("did-finish-load");
  expect(f.binding.getCurrentOwner()).not.toBeNull();
  f.binding.dispose();
});

it("revokes the window epoch on renderer crash until a completed reload", () => {
  const f = fixture(), owner = f.binding.getCurrentOwner();
  f.contents.emit("render-process-gone", {}, { reason: "crashed" });
  expect(owner?.signal.aborted).toBe(true); expect(f.binding.getCurrentOwner()).toBeNull();
  expect(f.binding.resolveOwner({ sender:f.contents, senderFrame:f.frame })).toBeNull();
  f.contents.mainFrame = {}; f.contents.emit("did-finish-load");
  const recovered = f.binding.getCurrentOwner();
  expect(recovered?.workspaceId).not.toBe(owner?.workspaceId); expect(recovered?.signal.aborted).toBe(false);
  f.binding.dispose(); expect(f.contents.listenerCount("render-process-gone")).toBe(0);
});
