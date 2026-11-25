import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { IPC } from "../../../../shared/ipc-channels";
import { registerPluginManagementIpc } from "./plugin-management-ipc";
import { PLUGIN_MANAGEMENT_FORBIDDEN } from "./plugin-management-ipc-guard";

const state = vi.hoisted(() => ({ isDev: true }));
vi.mock("../../../base/identity/env", () => ({ get isDev() { return state.isDev; } }));
vi.mock("electron", () => ({ app: { getAppPath: () => "E:\\app" } }));

function fakeHost(url = "http://localhost:5173/react/"): WebContents {
  const mainFrame = { url };
  return {
    isDestroyed: () => false,
    mainFrame,
    send: vi.fn(),
  } as unknown as WebContents;
}

function eventFrom(host: WebContents): IpcMainInvokeEvent {
  return {
    sender: host,
    senderFrame: (host as unknown as { mainFrame: unknown }).mainFrame,
  } as unknown as IpcMainInvokeEvent;
}

describe("registerPluginManagementIpc", () => {
  let handlers: Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>;
  let chatHost: WebContents;
  let controller: {
    listPlugins: ReturnType<typeof vi.fn>;
    enablePlugin: ReturnType<typeof vi.fn>;
    disablePlugin: ReturnType<typeof vi.fn>;
    grantPermission: ReturnType<typeof vi.fn>;
    revokePermission: ReturnType<typeof vi.fn>;
    setModelRateLimit: ReturnType<typeof vi.fn>;
    importFromPath: ReturnType<typeof vi.fn>;
    uninstallPlugin: ReturnType<typeof vi.fn>;
  };
  let selectPluginPackage: ReturnType<typeof vi.fn>;
  let selectPluginFolder: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handlers = new Map();
    chatHost = fakeHost();
    controller = {
      listPlugins: vi.fn(() => []),
      enablePlugin: vi.fn(async () => ({} as never)),
      disablePlugin: vi.fn(async () => ({} as never)),
      grantPermission: vi.fn(() => ({} as never)),
      revokePermission: vi.fn(() => ({} as never)),
      setModelRateLimit: vi.fn(() => ({} as never)),
      importFromPath: vi.fn(async () => ({ ok: true as const, installation: "committed" as const, activation: "not-requested" as const, plugin: { id: "dev.firefly.a", name: "A", version: "1.0.0" } })),
      uninstallPlugin: vi.fn(async () => ({ ok: true, uninstalled: true, cleanup: { secrets: "kept", data: "kept" } })),
    };
    selectPluginPackage = vi.fn(async () => "C:\\pkg.ffplugin");
    selectPluginFolder = vi.fn(async () => "C:\\plugin-dir");
    registerPluginManagementIpc({
      ipc: { handle: (channel, fn) => { handlers.set(channel, fn as never); } },
      hosts: { getManagementHost: () => chatHost, getPanelHost: () => null },
      controller: controller as never,
      selectPluginPackage: selectPluginPackage as never,
      selectPluginFolder: selectPluginFolder as never,
    });
  });

  it("rejects untrusted senders before touching controller or dialogs", async () => {
    const evilEvent = eventFrom(fakeHost("http://localhost:5173/"));
    for (const channel of [
      IPC.PLUGINS_SET_ENABLED,
      IPC.PLUGINS_SET_PERMISSION,
      IPC.PLUGINS_SET_MODEL_RATE_LIMIT,
      IPC.PLUGINS_IMPORT_ZIP,
      IPC.PLUGINS_IMPORT_FOLDER,
      IPC.PLUGINS_UNINSTALL,
    ]) {
      const res = await handlers.get(channel)!(evilEvent, "dev.firefly.a", true);
      expect(res).toEqual({ ok: false, error: PLUGIN_MANAGEMENT_FORBIDDEN });
    }
    expect(controller.enablePlugin).not.toHaveBeenCalled();
    expect(selectPluginPackage).not.toHaveBeenCalled();
    expect(selectPluginFolder).not.toHaveBeenCalled();
  });

  it("forwards package/folder imports, permissions, rate limit, and selective uninstall options", async () => {
    const trusted = eventFrom(chatHost);

    await handlers.get(IPC.PLUGINS_IMPORT_ZIP)!(trusted);
    expect(selectPluginPackage).toHaveBeenCalledTimes(1);
    expect(controller.importFromPath).toHaveBeenCalledWith("C:\\pkg.ffplugin");

    await handlers.get(IPC.PLUGINS_IMPORT_FOLDER)!(trusted);
    expect(selectPluginFolder).toHaveBeenCalledTimes(1);
    expect(controller.importFromPath).toHaveBeenCalledWith("C:\\plugin-dir");

    await handlers.get(IPC.PLUGINS_SET_PERMISSION)!(trusted, "dev.firefly.a", "secrets", false);
    expect(controller.revokePermission).toHaveBeenCalledWith("dev.firefly.a", "secrets");
    await handlers.get(IPC.PLUGINS_SET_PERMISSION)!(trusted, "dev.firefly.a", "secrets", true);
    expect(controller.grantPermission).toHaveBeenCalledWith("dev.firefly.a", "secrets");

    await handlers.get(IPC.PLUGINS_SET_MODEL_RATE_LIMIT)!(trusted, "dev.firefly.a", 30);
    expect(controller.setModelRateLimit).toHaveBeenCalledWith("dev.firefly.a", 30);

    const uninstallRes = await handlers.get(IPC.PLUGINS_UNINSTALL)!(trusted, "dev.firefly.a", { deleteSecrets: false, deleteData: true });
    expect(controller.uninstallPlugin).toHaveBeenCalledWith("dev.firefly.a", { deleteSecrets: false, deleteData: true });
    expect(uninstallRes).toMatchObject({
      ok: true,
      cleanup: { secrets: "kept", data: "kept" },
    });
  });
});
