import type { IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import { checkPluginManagementCaller, guardPluginIpcHandler, pluginManagementForbidden, PLUGIN_MANAGEMENT_FORBIDDEN } from "./plugin-management-ipc-guard";

vi.mock("../startup/env", () => ({ isDev: true }));
vi.mock("electron", () => ({ app: { getAppPath: () => process.cwd() } }));

function host(page = "react") {
  const mainFrame = { url: `http://localhost:5173/${page}/` };
  return { isDestroyed: () => false, mainFrame } as unknown as WebContents & { isDestroyed: () => boolean };
}
function fixture() {
  const chat = host(), settings = host("settings"), pet = host("pet");
  const hosts = { getManagementHost: () => chat as WebContents | null, getPanelHost: () => settings as WebContents | null };
  const from = (w: WebContents, frame: unknown = w.mainFrame) => ({ sender: w, senderFrame: frame }) as IpcMainInvokeEvent;
  return { chat, settings, pet, hosts, from };
}
const MANAGE = [IPC.PLUGINS_SET_ENABLED, IPC.PLUGINS_OPEN, IPC.PLUGINS_RESCAN, IPC.PLUGINS_IMPORT_ZIP, IPC.PLUGINS_UNINSTALL];

describe("plugin management IPC caller check", () => {
  it.each(["https://example.com/react/", "http://localhost:5173/settings/", "http://localhost:5173/react/other", "", "not a URL"])("rejects a navigated host document %s without invoking management", (url) => {
    const f = fixture(), invoke = vi.fn();
    Object.assign(f.chat.mainFrame, { url });
    const handler = guardPluginIpcHandler(IPC.PLUGINS_UNINSTALL, f.hosts, invoke);
    expect(handler(f.from(f.chat), "fixture")).toMatchObject({ ok: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("allows chat routing queries and settings hashes on the expected document", () => {
    const f = fixture();
    Object.assign(f.chat.mainFrame, { url: "http://localhost:5173/react/?session=fixture#plugins" });
    Object.assign(f.settings.mainFrame, { url: "http://localhost:5173/settings/#plugins" });
    expect(checkPluginManagementCaller(IPC.PLUGINS_LIST, f.from(f.chat), f.hosts)).toBe(true);
    expect(checkPluginManagementCaller(IPC.PLUGINS_LIST, f.from(f.settings), f.hosts)).toBe(true);
  });
  it.each(MANAGE)("%s is allowed only from the chat window main frame", (channel) => {
    const f = fixture();
    expect(checkPluginManagementCaller(channel, f.from(f.chat), f.hosts)).toBe(true);
    expect(checkPluginManagementCaller(channel, f.from(f.settings), f.hosts)).toBe(false);
    expect(checkPluginManagementCaller(channel, f.from(f.pet), f.hosts)).toBe(false);
  });

  it("the list may be read by the chat window and the settings window, not by others", () => {
    const f = fixture();
    expect(checkPluginManagementCaller(IPC.PLUGINS_LIST, f.from(f.chat), f.hosts)).toBe(true);
    expect(checkPluginManagementCaller(IPC.PLUGINS_LIST, f.from(f.settings), f.hosts)).toBe(true);
    expect(checkPluginManagementCaller(IPC.PLUGINS_LIST, f.from(f.pet), f.hosts)).toBe(false);
  });

  it.each(["subframe", "missing-frame", "missing-host", "destroyed-host", "replaced-host"])("fails closed for %s", (kind) => {
    const f = fixture();
    let event = f.from(f.chat);
    if (kind === "subframe") event = f.from(f.chat, {});
    if (kind === "missing-frame") event = f.from(f.chat, null);
    if (kind === "missing-host") f.hosts.getManagementHost = () => null;
    if (kind === "destroyed-host") f.chat.isDestroyed = () => true;
    if (kind === "replaced-host") f.hosts.getManagementHost = () => host();
    expect(checkPluginManagementCaller(IPC.PLUGINS_UNINSTALL, event, f.hosts)).toBe(false);
    expect(checkPluginManagementCaller(IPC.PLUGINS_LIST, event, f.hosts)).toBe(false);
  });

  it("does not apply to a plugin's own channels", () => {
    const f = fixture();
    expect(checkPluginManagementCaller("plugin:text-stats:count", f.from(f.pet), f.hosts)).toBeNull();
  });

  it("the wrapped handler never runs for a refused caller and passes arguments through otherwise", () => {
    const f = fixture(), invoke = vi.fn(() => ({ ok: true }));
    const uninstall = guardPluginIpcHandler(IPC.PLUGINS_UNINSTALL, f.hosts, invoke);
    expect(uninstall(f.from(f.pet), "text-stats")).toEqual({ ok: false, error: PLUGIN_MANAGEMENT_FORBIDDEN });
    expect(invoke).not.toHaveBeenCalled();
    expect(uninstall(f.from(f.chat), "text-stats")).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith(["text-stats"]);
    const own = guardPluginIpcHandler("plugin:text-stats:count", f.hosts, invoke);
    expect(own(f.from(f.pet), 1, 2)).toEqual({ ok: true });
    expect(invoke).toHaveBeenLastCalledWith([1, 2]);
  });

  it("keeps the overview shape when the list is refused", () => {
    expect(pluginManagementForbidden(IPC.PLUGINS_LIST)).toEqual({ ok: false, error: PLUGIN_MANAGEMENT_FORBIDDEN, plugins: [], issues: [] });
    expect(pluginManagementForbidden(IPC.PLUGINS_UNINSTALL)).toEqual({ ok: false, error: PLUGIN_MANAGEMENT_FORBIDDEN });
  });
});
