import { EventEmitter } from "node:events";
import type { App } from "electron";
import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ ipcMain: {} }));
import { createIpcScope } from "../application/ipc-scope";
import { createManualBrowserWorkspace } from "./manual-browser-workspace";
import { createBrowserService } from "./browser-service";
import { registerBrowserServiceIpc, registerManualBrowserWorkspaceIpc, installBrowserServiceLifecycle } from "./browser-service-ipc";
import { createShutdownCoordinator } from "../application/shutdown";
import { createStartupReadiness } from "../application/readiness";
import { registerBrowserHostOwner, registerManualBrowserHostOwner } from "./browser-host-owner";
import { createActiveChatTargetRegistry } from "../plugin-host/active-chat-target";
import type { BrowserHostPort } from "./browser-service";
import type { WebContents } from "electron";

function closedService() {
  return createBrowserService({ profile: {}, createSession: () => { throw Error("must not allocate"); }, createView: () => { throw Error("must not allocate"); } });
}
describe("Main browser IPC and existing lifecycle consumers", () => {
  it("routes manual workspace and Agent consent to independently owned services", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>(), profile = {}, frame = {};
    const contents = Object.assign(new EventEmitter(), { id: 45, mainFrame: frame, isDestroyed: () => false });
    const host: BrowserHostPort = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false,
      isVisible: () => true, isFocused: () => true, getContentSize: () => [800, 600], contentView: { addChildView: () => {}, removeChildView: () => {} } });
    const scope = createIpcScope({ handle: (key, value) => handlers.set(key, value), on: () => {}, removeHandler: key => handlers.delete(key), removeListener: () => {} });
    const options = { profile, manualBrowsing: true, permissionPolicy: { hosts: ["example.com"], actions: ["navigate" as const] },
      confirmPermission: async () => true, createSession: () => { throw Error("no page requested"); }, createView: () => { throw Error("no page requested"); } };
    const manual = createManualBrowserWorkspace({ createService: onChanged => createBrowserService({ ...options, onChanged }), onChanged() {} }), agent = createBrowserService(options), targets = createActiveChatTargetRegistry();
    const manualBinding = registerManualBrowserHostOwner({ host, profile, service: manual });
    const agentBinding = registerBrowserHostOwner({ host, profile, service: agent, targets, readSession: id => ({ id, mode: "chat" }) });
    registerBrowserServiceIpc(scope, agent);
    registerManualBrowserWorkspaceIpc(scope, manual);
    const event = { sender: contents, senderFrame: frame }, permission = handlers.get("browser:workspace:permission")!, agentPermission = handlers.get("browser:permission")!;
    expect(await handlers.get("browser:workspace:command")!({ ...event, senderFrame: null }, { kind: "tabs" })).toEqual({ ok: false, code: "owner_mismatch" });
    expect(await handlers.get("browser:workspace:command")!(event, { kind: "tabs" })).toMatchObject({ ok: true, value: { tabs: [{ page: null }] } });
    expect(await permission(event, { kind: "get" })).toMatchObject({ ok: true, value: { conversationId: null, workspaceId: manualBinding.getCurrentOwner()?.workspaceId } });
    expect(await agentPermission(event, { kind: "get" })).toEqual({ ok: false, code: "owner_mismatch" });
    targets.setActive({ sender: contents as unknown as WebContents, sessionId: "a", mode: "chat", rendererTargetId: "r" }); agentBinding.refresh();
    await permission(event, { kind: "request", scope: { mode: "manual", hosts: ["example.com"], resourceHosts: [], actions: ["navigate"] } });
    expect(await agentPermission(event, { kind: "request", scope: { mode: "agent", hosts: ["example.com"], actions: ["navigate"] } })).toMatchObject({ ok: true, value: { conversationId: "a", status: "granted" } });
    targets.clearActive(contents as unknown as WebContents); agentBinding.refresh();
    expect(await agentPermission(event, { kind: "get" })).toEqual({ ok: false, code: "owner_mismatch" });
    expect(await permission(event, { kind: "get" })).toMatchObject({ ok: true, value: { conversationId: null, status: "granted" } });
    manualBinding.dispose(); agentBinding.dispose(); targets.dispose(); scope.dispose(); await manual.dispose(); await agent.dispose();
  });
  it("uses shared IpcScope and returns real closed service availability, with no renderer gate field", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const scope = createIpcScope({ handle: (key, value) => handlers.set(key, value), on: () => {}, removeHandler: key => handlers.delete(key), removeListener: () => {} });
    registerBrowserServiceIpc(scope, closedService());
    expect(await handlers.get("browser:availability")?.({}, { gateOpen: true })).toEqual({ available: false, reason: "network_unavailable" });
    expect(await handlers.get("browser:command")?.({ sender: {}, senderFrame: {} }, { kind: "open", url: "https://example.com/", gateOpen: true })).toEqual({ ok: false, code: "owner_mismatch" });
    scope.dispose(); expect(handlers.size).toBe(0);
  });
  it("denies managed target login/client certificate/bad TLS and leaves unrelated consumers untouched", () => {
    const service = closedService(), managed = { id: 42, session: {}, isDestroyed: () => false }, other = { ...managed }, app = new EventEmitter();
    const wrapped = { ...service, isRegisteredBrowser: (contents: object) => contents === managed, credentialsFor: () => null };
    const registrations: unknown[] = []; const stop = installBrowserServiceLifecycle(app as unknown as Pick<App, "on" | "removeListener">, wrapped, { register: input => { registrations.push(input); return () => {}; } });
    const preventDefault = vi.fn(), callback = vi.fn();
    app.emit("login", { preventDefault }, managed, {}, { isProxy: false, host: "example.com", port: 443, realm: "site", scheme: "basic" }, callback); expect(callback).toHaveBeenCalledWith();
    app.emit("select-client-certificate", { preventDefault }, managed, "https://example.com", [], callback); expect(callback).toHaveBeenLastCalledWith();
    app.emit("certificate-error", { preventDefault }, managed, "https://example.com", "bad", {}, callback); expect(callback).toHaveBeenLastCalledWith(false);
    const calls = callback.mock.calls.length; app.emit("login", { preventDefault }, other, {}, {}, callback); expect(callback).toHaveBeenCalledTimes(calls);
    stop(); expect(app.listenerCount("login")).toBe(0); expect(registrations).toHaveLength(2);
  });
  it("registers revoke before disposal in the real ShutdownCoordinator, and errors are visible", async () => {
    const readiness = createStartupReadiness(); readiness.transition("shell-ready");
    const order: string[] = [], logs: string[] = [], shutdown = createShutdownCoordinator({ readiness, log: message => logs.push(message) });
    const service = { ...closedService(), revokeAll: () => { order.push("revoke"); }, dispose: async () => { order.push("dispose"); return { ok: false as const, code: "cleanup_failed" as const }; } };
    installBrowserServiceLifecycle(new EventEmitter() as unknown as Pick<App, "on" | "removeListener">, service, shutdown);
    await shutdown.requestControlledShutdown({ reason: "fixture", finalAction: () => { order.push("exit"); } });
    expect(order).toEqual(["revoke", "dispose", "exit"]); expect(logs.some(message => message.includes("browser-service-dispose"))).toBe(true);
  });
  it("quiesces and disposes both independent manual and Agent services without registration collisions", async () => {
    const readiness = createStartupReadiness(); readiness.transition("shell-ready");
    const order: string[] = [], shutdown = createShutdownCoordinator({ readiness });
    for (const id of ["browser-service", "manual-browser-service"] as const) {
      installBrowserServiceLifecycle(new EventEmitter() as unknown as Pick<App, "on" | "removeListener">,
        { ...closedService(), revokeAll: () => { order.push(`${id}:revoke`); },
          dispose: async () => { order.push(`${id}:dispose`); return { ok: true as const, value: null }; } }, shutdown, id);
    }
    await shutdown.requestControlledShutdown({ reason: "fixture", finalAction: () => { order.push("exit"); } });
    expect(order).toEqual(["browser-service:revoke", "manual-browser-service:revoke", "browser-service:dispose", "manual-browser-service:dispose", "exit"]);
  });
});
