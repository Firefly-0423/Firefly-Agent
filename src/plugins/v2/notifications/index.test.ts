import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRpcEndpoint } from "../../../shared/plugin-rpc";
import { createPluginNotifications, type NotificationAccess } from "./index";

function fixture() {
  const listeners = new Set<() => void>();
  let access: NotificationAccess | null = { name: "真实插件", declared: ["notifications"], granted: new Set(["notifications"]), revision: 1 };
  const notices: Array<EventEmitter & { show: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const deps = {
    access: () => access,
    onAccessChange: (_id: string, listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    isSupported: vi.fn(() => true),
    isEnabled: vi.fn(() => true),
    create: vi.fn((_options: { title: string; body: string }) => {
      const notice = Object.assign(new EventEmitter(), { show: vi.fn(), close: vi.fn() });
      notices.push(notice); return notice;
    }),
    focusMainWindow: vi.fn(),
  };
  const service = createPluginNotifications(deps);
  let hostReceive = (_v: unknown) => {}, clientReceive = (_v: unknown) => {};
  const host = createRpcEndpoint({ post: f => clientReceive(f), onFrame: fn => { hostReceive = fn; return () => {}; } });
  const client = createRpcEndpoint({ post: f => hostReceive(f), onFrame: fn => { clientReceive = fn; return () => {}; } });
  const disconnect = service.configureRpc("plugin", host);
  return { deps, notices, service, disconnect,
    change: (value: NotificationAccess | null) => { access = value; listeners.forEach(fn => fn()); },
    show: (input: unknown = { title: "标题", body: "正文" }) => client.call("notifications.show", input),
    close: () => { service.dispose(); client.close(); host.close(); },
  };
}
afterEach(() => vi.useRealTimers());
describe("plugin notification RPC", () => {
  it.each([
    [[], [], "ERR_UNDECLARED"],
    [["notifications"], [], "ERR_PERMISSION"],
  ])("rejects declaration %j grants %j without creating a notification", async (declared, granted, code) => {
    const f = fixture();
    try {
      f.change({ name: "name", declared, granted: new Set(granted), revision: 2 });
      await expect(f.show()).rejects.toMatchObject({ code });
      expect(f.deps.create).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it("adds the installed name, strips controls and waits for the system show acknowledgement", async () => {
    const f = fixture();
    try {
      const result = f.show({ title: "〔Firefly〕\u202e标题", body: "正文\u0000" });
      expect(f.deps.create).toHaveBeenCalledExactlyOnceWith({ title: "〔真实插件〕〔Firefly〕标题", body: "正文" });
      expect(f.notices[0].show).toHaveBeenCalledOnce();
      f.notices[0].emit("show");
      await expect(result).resolves.toEqual({ shown: true });
      f.notices[0].emit("click", { url: "https://untrusted.invalid" });
      expect(f.deps.focusMainWindow).toHaveBeenCalledExactlyOnceWith();
    } finally { f.close(); }
  });
  it.each(["unsupported", "failed", "timeout", "throw"])("returns false for %s without reporting delivery", async reason => {
    vi.useFakeTimers(); const f = fixture();
    try {
      if (reason === "unsupported") f.deps.isSupported.mockReturnValue(false);
      if (reason === "throw") f.deps.create.mockImplementation(() => { throw new Error("platform failure"); });
      const result = f.show();
      if (reason === "failed") f.notices[0].emit("failed", {}, "system disabled");
      if (reason === "timeout") await vi.advanceTimersByTimeAsync(5000);
      await expect(result).resolves.toEqual({ shown: false });
      if (reason === "unsupported") expect(f.deps.create).not.toHaveBeenCalled();
      if (reason === "timeout" || reason === "failed") expect(f.notices[0].close).toHaveBeenCalledOnce();
    } finally { f.close(); }
  });
  it("respects a host visibility setting without creating a native notification", async () => {
    const f = fixture();
    try { f.deps.isEnabled.mockReturnValue(false); await expect(f.show()).resolves.toEqual({ shown: false }); expect(f.deps.create).not.toHaveBeenCalled(); }
    finally { f.close(); }
  });
  it.each(["revoke", "disable", "disconnect"])("cancels pending delivery on %s and ignores later show/click", async reason => {
    const f = fixture();
    try {
      const result = f.show();
      const rejected = expect(result).rejects.toMatchObject({ code: reason === "disconnect" ? "ERR_CANCELLED" : "ERR_PERMISSION" });
      if (reason === "revoke") f.change({ name: "name", declared: ["notifications"], granted: new Set(), revision: 2 });
      else if (reason === "disable") f.change(null);
      else f.disconnect();
      await rejected;
      expect(f.notices[0].close).toHaveBeenCalledOnce();
      f.notices[0].emit("show"); f.notices[0].emit("click");
      expect(f.deps.focusMainWindow).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it("permits five attempts and rejects the sixth until the 60-second boundary", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const f = fixture();
    try {
      for (let n = 0; n < 5; n++) { const result = f.show(); f.notices[n].emit("show"); await result; }
      await expect(f.show()).rejects.toMatchObject({ code: "ERR_RATE_LIMITED" });
      await vi.advanceTimersByTimeAsync(59_999);
      await expect(f.show()).rejects.toMatchObject({ code: "ERR_RATE_LIMITED" });
      await vi.advanceTimersByTimeAsync(1);
      const result = f.show(); f.notices[5].emit("show"); await expect(result).resolves.toEqual({ shown: true });
      expect(f.deps.create).toHaveBeenCalledTimes(6);
    } finally { f.close(); }
  });
  it.each([{ title: "x".repeat(65), body: "b" }, { title: "t", body: "x".repeat(257) }, { title: "t", body: "b", icon: "file" }])("rejects invalid input before creating a notification: %j", async input => {
    const f = fixture(); try { await expect(f.show(input)).rejects.toMatchObject({ code: "ERR_INVALID_ARGUMENT" }); expect(f.deps.create).not.toHaveBeenCalled(); } finally { f.close(); }
  });
  it("accepts exact Unicode code point boundaries after removing controls", async () => {
    const f = fixture();
    try {
      const result = f.show({ title: "😀".repeat(64) + "\u0000", body: "😀".repeat(256) + "\u202e" });
      expect(f.deps.create).toHaveBeenCalledExactlyOnceWith({ title: "〔真实插件〕" + "😀".repeat(64), body: "😀".repeat(256) });
      f.notices[0].emit("show"); await expect(result).resolves.toEqual({ shown: true });
    } finally { f.close(); }
  });
  it("closes an already shown notification when permission is revoked", async () => {
    const f = fixture();
    try {
      const result = f.show(); f.notices[0].emit("show"); await result;
      f.change({ name: "name", declared: ["notifications"], granted: new Set(), revision: 2 });
      expect(f.notices[0].close).toHaveBeenCalledOnce();
      f.notices[0].emit("click"); expect(f.deps.focusMainWindow).not.toHaveBeenCalled();
      await expect(f.show()).rejects.toMatchObject({ code: "ERR_PERMISSION" });
      expect(f.deps.create).toHaveBeenCalledOnce();
    } finally { f.close(); }
  });
  it("closes pending native delivery when the caller cancels", async () => {
    let handler: ((input: unknown, context: { signal: AbortSignal }) => unknown) | undefined;
    const f = fixture();
    const rpc = { handle: (_method: string, callback: typeof handler) => { handler = callback; return () => {}; } };
    const disconnect = f.service.configureRpc("other", rpc as never);
    try {
      const controller = new AbortController();
      const result = handler!({ title: "t", body: "b" }, { signal: controller.signal });
      const rejected = expect(result).rejects.toMatchObject({ code: "ERR_CANCELLED" });
      controller.abort(); await rejected;
      expect(f.notices[0].close).toHaveBeenCalledOnce();
    } finally { disconnect(); f.close(); }
  });
});
