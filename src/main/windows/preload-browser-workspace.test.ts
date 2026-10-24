import { beforeEach, expect, it, vi } from "vitest";
import { MANUAL_BROWSER_WORKSPACE_IPC as channels } from "../../shared/manual-browser";
const fixture = vi.hoisted(() => ({ exposed: new Map<string, any>(), listeners: new Map<string, Set<(...args: any[]) => void>>(), invoke: vi.fn(), send: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: (name: string, value: unknown) => fixture.exposed.set(name, value) }, ipcRenderer: { invoke: fixture.invoke, send: fixture.send,
  on: (channel: string, listener: (...args: any[]) => void) => { const set = fixture.listeners.get(channel) ?? new Set(); set.add(listener); fixture.listeners.set(channel, set); },
  removeListener: (channel: string, listener: (...args: any[]) => void) => fixture.listeners.get(channel)?.delete(listener) }, webUtils: {} }));
beforeEach(async () => { vi.resetModules(); fixture.exposed.clear(); fixture.listeners.clear(); fixture.invoke.mockReset(); fixture.send.mockReset(); await import("../../preload/index"); });
it("routes workspace/tab commands only through the dedicated channels while preserving the conversation bridge", async () => {
  const api = fixture.exposed.get("manualBrowserWorkspace"), scope = { mode: "manual", hosts: ["example.com"], resourceHosts: [], actions: ["navigate"] };
  fixture.invoke.mockResolvedValue({ ok: true, value: null });
  await api.getAvailability(); await api.getTabs(); await api.newTab(); await api.selectTab("a"); await api.closeTab("b");
  await api.getPermission("a"); await api.requestPermission(scope, "a"); await api.revokePermission("w", "a"); await api.execute({ kind: "open", url: "https://example.com/" }, "a");
  expect(fixture.invoke.mock.calls).toEqual([
    [channels.availability], [channels.command, { kind: "tabs" }], [channels.command, { kind: "new-tab" }],
    [channels.command, { kind: "select-tab", tabId: "a" }], [channels.command, { kind: "close-tab", tabId: "b" }],
    [channels.permission, { kind: "get", tabId: "a" }], [channels.permission, { kind: "request", tabId: "a", scope }],
    [channels.permission, { kind: "revoke", workspaceId: "w", tabId: "a" }], [channels.command, { kind: "open", url: "https://example.com/", tabId: "a" }],
  ]);
  await fixture.exposed.get("manualBrowser").revokePermission("conversation");
  expect(fixture.invoke).toHaveBeenLastCalledWith("browser:permission", { kind: "revoke", conversationId: "conversation" });
  expect(api.grant).toBeUndefined(); expect(fixture.send).not.toHaveBeenCalled();
});
it("passes only workspace DTOs to the renderer and removes the exact listener", () => {
  const api = fixture.exposed.get("manualBrowserWorkspace"), seen: unknown[] = [];
  const off = api.onChanged((value: unknown) => seen.push(value));
  const dto = { conversationId: null, workspaceId: "w", tabId: "a", browserId: "b", requestId: 1 };
  for (const listener of fixture.listeners.get(channels.changed) ?? []) listener({ sender: "native-event" }, dto);
  expect(seen).toEqual([dto]); off();
  for (const listener of fixture.listeners.get(channels.changed) ?? []) listener({}, dto);
  expect(seen).toHaveLength(1);
});
it("sends tool requests through the workspace command channel and delivers tool changes until unsubscribed", async () => {
  const api = fixture.exposed.get("manualBrowserWorkspace");
  fixture.invoke.mockResolvedValue({ ok: true, value: { downloads: [] } });
  await api.tool({ tool: "download", op: "list" }); await api.tool({ tool: "zoom", op: "in" }, "tab-a");
  expect(fixture.invoke.mock.calls).toEqual([
    [channels.command, { kind: "tool", request: { tool: "download", op: "list" } }],
    [channels.command, { kind: "tool", request: { tool: "zoom", op: "in" }, tabId: "tab-a" }],
  ]);
  const seen: unknown[] = [], off = api.onToolsChanged((change: unknown) => seen.push(change));
  const change = { kind: "downloads", downloads: [] };
  for (const listener of fixture.listeners.get(channels.toolsChanged) ?? []) listener({ sender: "native-event" }, change);
  expect(seen).toEqual([change]); off();
  for (const listener of fixture.listeners.get(channels.toolsChanged) ?? []) listener({}, change);
  expect(seen).toHaveLength(1);
});
