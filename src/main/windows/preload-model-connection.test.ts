import { beforeEach, expect, it, vi } from "vitest";
import { getOfflineBrowserAvailability } from "../browser/browser-availability-ipc";
const fixture = vi.hoisted(() => ({ exposed: new Map<string, any>(), listeners: new Map<string, Set<(...args: any[]) => void>>(), invoke: vi.fn(), send: vi.fn() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (name: string, value: unknown) => fixture.exposed.set(name, value) },
  ipcRenderer: { invoke: fixture.invoke, send: fixture.send,
    on: (channel: string, listener: (...args: any[]) => void) => { const set = fixture.listeners.get(channel) ?? new Set(); set.add(listener); fixture.listeners.set(channel, set); },
    removeListener: (channel: string, listener: (...args: any[]) => void) => fixture.listeners.get(channel)?.delete(listener),
  }, webUtils: {},
}));
beforeEach(async () => { vi.resetModules(); fixture.exposed.clear(); fixture.listeners.clear(); fixture.invoke.mockReset(); fixture.send.mockReset(); await import("../../preload/index"); });
it("exposes snapshot reads and removes the exact connection event listener", async () => {
  const api = fixture.exposed.get("modelConfig");
  expect(typeof api.getConnectionSnapshot).toBe("function");
  fixture.invoke.mockResolvedValue({ profiles: [] }); expect(await api.getConnectionSnapshot()).toEqual({ profiles: [] });
  expect(fixture.invoke).toHaveBeenCalledWith("model-connection:get");
  const seen: unknown[] = []; const off = api.onConnectionChanged((value: unknown) => seen.push(value));
  const snapshot = { profiles: [{ profileId: "fixture", revision: 1, state: "unverified" }] };
  for (const listener of fixture.listeners.get("model-connection:changed") ?? []) listener({}, snapshot);
  expect(seen).toEqual([snapshot]); off();
  for (const listener of fixture.listeners.get("model-connection:changed") ?? []) listener({}, snapshot);
  expect(seen).toHaveLength(1);
});
it("binds browser cleanup to its conversation while preserving explicit current-owner revocation", async () => {
  const api = fixture.exposed.get("manualBrowser");
  await api.revokePermission("s");
  expect(fixture.invoke).toHaveBeenLastCalledWith("browser:permission", { kind: "revoke", conversationId: "s" });
  await api.revokePermission();
  expect(fixture.invoke).toHaveBeenLastCalledWith("browser:permission", { kind: "revoke" });
});
it("preserves the sidebar settings action", () => {
  const sidebar = fixture.exposed.get("sidebar"); sidebar.openSettings("api");
  expect(fixture.send.mock.calls).toEqual([["sidebar:open-settings", "api"]]);
});
it("exposes manual commands and Main-confirmed permission requests, preserving offline availability", async () => {
  const api = fixture.exposed.get("manualBrowser");
  expect(Object.keys(api).sort()).toEqual(["getAvailability", "execute", "onChanged", "getPermission", "requestPermission", "revokePermission"].sort());
  fixture.invoke.mockImplementation(async (channel: string) => {
    expect(channel).toBe("browser:availability");
    return getOfflineBrowserAvailability();
  });
  expect(await api.getAvailability()).toEqual({ available: false, reason: "network_unavailable" });
  expect(fixture.invoke).toHaveBeenCalledWith("browser:availability");
  expect(fixture.send).not.toHaveBeenCalled();
});

it("passes manual command data unchanged and unsubscribes the exact browser DTO listener", async () => {
  const api = fixture.exposed.get("manualBrowser");
  const command = { kind: "layout", browserId: "main-minted-id", bounds: null };
  fixture.invoke.mockResolvedValue({ ok: true, value: null });
  expect(await api.execute(command)).toEqual({ ok: true, value: null });
  expect(fixture.invoke).toHaveBeenCalledWith("browser:command", command);
  const seen: unknown[] = []; const off = api.onChanged((value: unknown) => seen.push(value));
  const dto = { conversationId: "s", browserId: "b", requestId: 4, closed: true };
  for (const listener of fixture.listeners.get("browser:changed") ?? []) listener({}, dto);
  expect(seen).toEqual([dto]); off();
  for (const listener of fixture.listeners.get("browser:changed") ?? []) listener({}, dto);
  expect(seen).toHaveLength(1); expect(fixture.send).not.toHaveBeenCalled();
});

it("routes permission requests to Main without exposing a renderer grant switch", async () => {
  const api = fixture.exposed.get("manualBrowser");
  const scope = { hosts: ["example.com"], actions: ["navigate"] };
  fixture.invoke.mockResolvedValue({ ok: false, code: "permission_denied" });
  await api.getPermission(); await api.requestPermission(scope); await api.revokePermission();
  expect(fixture.invoke.mock.calls).toEqual([
    ["browser:permission", { kind: "get" }],
    ["browser:permission", { kind: "request", scope }],
    ["browser:permission", { kind: "revoke" }],
  ]);
  expect(api.grant).toBeUndefined();
});

it("exposes read-only custom colors and detaches its exact update listener", async () => {
  const api = fixture.exposed.get("fireflyTheme");
  const colors = { enabled: true, accent: "#123456", background: "#ffffff", foreground: "#111111" };
  fixture.invoke.mockResolvedValue(colors);
  expect(await api.getColors()).toEqual(colors); expect(fixture.invoke).toHaveBeenCalledWith("ui-colors:get");
  const seen: unknown[] = []; const off = api.onColorsChanged((value: unknown) => seen.push(value));
  for (const listener of fixture.listeners.get("ui-colors:changed") ?? []) listener({}, colors);
  expect(seen).toEqual([colors]); off();
  for (const listener of fixture.listeners.get("ui-colors:changed") ?? []) listener({}, colors);
  expect(seen).toHaveLength(1);
});
