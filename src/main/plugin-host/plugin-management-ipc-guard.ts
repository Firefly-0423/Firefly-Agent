import type { IpcMainInvokeEvent, WebContents } from "electron";
import { app } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDev } from "../startup/env";
import { IPC } from "../../shared/ipc-channels";

/** 只读：React 聊天窗口的插件页和设置窗口（插件面板、定时任务页）都会读取列表。 */
const READ_CHANNELS = new Set<string>([IPC.PLUGINS_LIST]);
/** 改变插件状态或打开窗口：只有 React 聊天窗口的插件页会调用。 */
const MANAGE_CHANNELS = new Set<string>([
  IPC.PLUGINS_SET_ENABLED,
  IPC.PLUGINS_OPEN,
  IPC.PLUGINS_RESCAN,
  IPC.PLUGINS_IMPORT_ZIP,
  IPC.PLUGINS_UNINSTALL,
]);

export interface PluginIpcHosts {
  /** React 聊天窗口（插件页与插件市场所在窗口）。 */
  getManagementHost: () => WebContents | null;
  /** 设置窗口（插件设置面板宿主）。 */
  getPanelHost: () => WebContents | null;
}

/** 调用必须来自仍存活的宿主窗口的主 frame；子 frame、其他窗口一律拒绝。 */
export function isFromHostMainFrame(event: IpcMainInvokeEvent, host: WebContents | null): boolean {
  return Boolean(event && host && !host.isDestroyed() && event.sender === host
    && event.senderFrame && event.senderFrame === host.mainFrame);
}

/** Bind an existing host to its shipped document, not merely to a window identity. */
export function isFromHostDocument(event: IpcMainInvokeEvent, host: WebContents | null, page: "react" | "settings" | "pet"): boolean {
  if (!isFromHostMainFrame(event, host)) return false;
  try {
    const actual = new URL(event.senderFrame!.url);
    actual.hash = "";
    // React routing uses query parameters; settings only uses fragment navigation.
    if (page === "react") actual.search = "";
    const expected = isDev ? (page === "pet" ? "http://localhost:5173/" : `http://localhost:5173/${page}/`)
      : pathToFileURL(path.join(app.getAppPath(), "dist", "renderer", page === "pet" ? "" : page, "index.html")).href;
    return actual.href === expected;
  } catch { return false; }
}

export const PLUGIN_MANAGEMENT_FORBIDDEN = "插件管理调用来源窗口不受信任";

/**
 * 宿主管理通道（plugins:*）的来源校验。插件自己注册的 plugin:<id>:* 通道不在此列，返回 null 表示不适用。
 * 返回 true 放行，false 拒绝。
 */
export function checkPluginManagementCaller(
  channel: string,
  event: IpcMainInvokeEvent,
  hosts: PluginIpcHosts,
): boolean | null {
  if (READ_CHANNELS.has(channel)) {
    return isFromHostDocument(event, hosts.getManagementHost(), "react") || isFromHostDocument(event, hosts.getPanelHost(), "settings");
  }
  if (MANAGE_CHANNELS.has(channel)) return isFromHostDocument(event, hosts.getManagementHost(), "react");
  return null;
}

/** 包装 ipcMain handler：管理通道先校验来源，被拒绝时不调用 handler。 */
export function guardPluginIpcHandler(
  channel: string,
  hosts: PluginIpcHosts,
  invoke: (args: unknown[]) => unknown,
): (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown {
  return (event, ...args) => checkPluginManagementCaller(channel, event, hosts) === false
    ? pluginManagementForbidden(channel)
    : invoke(args);
}

/** 拒绝时的返回值：列表保持 PluginOverview 形状，渲染端照常处理为空列表。 */
export function pluginManagementForbidden(channel: string): Record<string, unknown> {
  return READ_CHANNELS.has(channel)
    ? { ok: false, error: PLUGIN_MANAGEMENT_FORBIDDEN, plugins: [], issues: [] }
    : { ok: false, error: PLUGIN_MANAGEMENT_FORBIDDEN };
}
