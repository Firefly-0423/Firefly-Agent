import { app, dialog, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { IPC } from "../../shared/ipc-channels";
import type { IpcScope } from "../application/ipc-scope";
import { isDev } from "../env";
import type { McpServerConfig } from "./mcp-adapter";
import type { McpFailureReason } from "./mcp-failure";
import { addMcpServer, listMcpServerConfigs, listMcpServers, removeMcpServer, setMcpServerEnabled } from "./mcp-manager";

const keys = new Set(["id", "name", "transport", "command", "args", "env", "cwd", "url"]);
const failure = (code: string, reason?: McpFailureReason) => ({ ok: false as const, code, error: code, ...(reason ? { reason } : {}) });
function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => "value" in descriptor);
}
function text(value: unknown, limit: number, blank = false): value is string {
  return typeof value === "string" && value.length <= limit && !value.includes("\0") && (blank || value.trim().length > 0);
}
function parseConfig(input: unknown): McpServerConfig | undefined {
  if (!record(input) || Object.keys(input).some(key => !keys.has(key)) || !text(input.id, 128) || !text(input.name, 256)) return;
  if (input.transport !== "stdio" && input.transport !== "sse") return;
  const config: McpServerConfig = { id: input.id, name: input.name, transport: input.transport };
  if (input.transport === "stdio") {
    if (!text(input.command, 8192) || input.url !== undefined) return;
    config.command = input.command;
    if (input.args !== undefined) {
      if (!Array.isArray(input.args) || input.args.length > 256 || ![...input.args].every(value => text(value, 8192, true))) return;
      config.args = [...input.args];
    }
    if (input.cwd !== undefined) {
      if (!text(input.cwd, 8192)) return;
      config.cwd = input.cwd;
    }
    if (input.env !== undefined) {
      if (!record(input.env) || Object.keys(input.env).length > 128) return;
      const entries = Object.entries(input.env);
      if (entries.some(([key, value]) => !text(key, 256) || key.includes("=") || !text(value, 8192, true))) return;
      config.env = Object.fromEntries(entries) as Record<string, string>;
    }
  } else {
    if (!text(input.url, 8192) || [input.command, input.args, input.env, input.cwd].some(value => value !== undefined)) return;
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return;
    config.url = input.url;
  }
  return Buffer.byteLength(JSON.stringify(config), "utf8") <= 64 * 1024 ? config : undefined;
}

function describeConfig(config: McpServerConfig): string {
  return config.transport === "stdio"
    ? `程序：${JSON.stringify(config.command)}\n参数：${JSON.stringify(config.args ?? [])}\n工作目录：${JSON.stringify(config.cwd ?? "默认")}\n环境变量名称：${JSON.stringify(Object.keys(config.env ?? {}))}`
    : `地址：${new URL(config.url!).origin}${new URL(config.url!).pathname}`;
}

export function registerMcpManagementIpc(deps: {
  ipc: Pick<IpcScope, "handle">;
  getSettingsWindow: () => BrowserWindow | null;
}): void {
  const pending = new WeakSet<object>();
  function ownerFor(event: IpcMainInvokeEvent): BrowserWindow | undefined {
    const window = deps.getSettingsWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || event.sender !== window.webContents || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) return;
    const expected = isDev ? "http://localhost:5173/settings/" : pathToFileURL(path.join(app.getAppPath(), "dist", "renderer", "settings", "index.html")).href;
    const frameUrl = new URL(event.senderFrame.url);
    const currentUrl = new URL(window.webContents.getURL());
    frameUrl.hash = ""; currentUrl.hash = "";
    return frameUrl.href === expected && currentUrl.href === expected ? window : undefined;
  }
  function safeOwner(event: IpcMainInvokeEvent): BrowserWindow | undefined {
    try { return ownerFor(event); } catch { return; }
  }
  async function mutate(event: IpcMainInvokeEvent, description: string, detail: string, operation: () => Promise<{ ok: boolean; toolIds?: string[]; reason?: McpFailureReason }>, options: { confirm?: boolean } = {}) {
    const owner = safeOwner(event);
    if (!owner) return failure("MCP_FORBIDDEN");
    if (pending.has(owner.webContents)) return failure("MCP_BUSY");
    const contents = owner.webContents;
    pending.add(contents);
    let revoked = false;
    const revoke = () => { revoked = true; };
    const navigate = (details: { isMainFrame: boolean }) => { if (details.isMainFrame) revoke(); };
    contents.on("did-start-navigation", navigate);
    contents.on("render-process-gone", revoke);
    contents.on("destroyed", revoke);
    try {
      // Turning a server off needs no confirmation; anything that starts a program does.
      const approval = options.confirm === false ? { response: 1 } : await dialog.showMessageBox(owner, {
        type: "warning", title: "Firefly · MCP", message: description,
        detail: "MCP 服务可能执行本机程序、访问文件或连接网络。仅在确认来源及操作后继续。\n" + detail,
        buttons: ["取消", "继续"], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (revoked || safeOwner(event) !== owner) return failure("MCP_FORBIDDEN");
      if (approval.response !== 1) return failure("MCP_CANCELLED");
      const result = await operation();
      return result.ok ? { ok: true as const, ...(result.toolIds ? { toolIds: [...result.toolIds] } : {}) } : failure("MCP_OPERATION_FAILED", result.reason);
    } catch {
      return failure("MCP_OPERATION_FAILED");
    } finally {
      contents.removeListener("did-start-navigation", navigate);
      contents.removeListener("render-process-gone", revoke);
      contents.removeListener("destroyed", revoke);
      pending.delete(contents);
    }
  }
  deps.ipc.handle(IPC.MCP_ADD_SERVER, (event: IpcMainInvokeEvent, input: unknown) => {
    if (!safeOwner(event)) return failure("MCP_FORBIDDEN");
    let config: McpServerConfig | undefined;
    try { config = parseConfig(input); } catch { return failure("MCP_INVALID_REQUEST"); }
    if (!config) return failure("MCP_INVALID_REQUEST");
    if (config.id === "playwright-mcp") return failure("MCP_BUILTIN_MANAGED");
    const approved = config;
    const detail = describeConfig(approved);
    return mutate(event, `添加并连接 MCP：${JSON.stringify(approved.name)}`, detail, () => addMcpServer(approved));
  });
  deps.ipc.handle(IPC.MCP_REMOVE_SERVER, (event: IpcMainInvokeEvent, input: unknown) => {
    if (!safeOwner(event)) return failure("MCP_FORBIDDEN");
    if (!text(input, 128)) return failure("MCP_INVALID_REQUEST");
    if (input === "playwright-mcp") return failure("MCP_BUILTIN_MANAGED");
    return mutate(event, `移除并断开 MCP：${JSON.stringify(input)}`, "移除后不会再按这份配置自动连接。", () => removeMcpServer(input));
  });
  deps.ipc.handle(IPC.MCP_SET_ENABLED, (event: IpcMainInvokeEvent, input: unknown) => {
    if (!safeOwner(event)) return failure("MCP_FORBIDDEN");
    if (!record(input) || Object.keys(input).length !== 2 || !text(input.id, 128) || typeof input.enabled !== "boolean") return failure("MCP_INVALID_REQUEST");
    const id = input.id, enabled = input.enabled;
    if (id === "playwright-mcp") return failure("MCP_BUILTIN_MANAGED");
    let stored: McpServerConfig | undefined;
    try { stored = listMcpServerConfigs().find(config => config.id === id); } catch { return failure("MCP_OPERATION_FAILED"); }
    if (!stored) return failure("MCP_NOT_FOUND");
    // Starting a program asks for confirmation again, showing exactly what will run; stopping one does not.
    return mutate(event, `${enabled ? "启用并连接" : "停用"} MCP：${JSON.stringify(stored.name)}`, describeConfig(stored), () => setMcpServerEnabled(id, enabled), { confirm: enabled });
  });
  deps.ipc.handle(IPC.MCP_LIST_SERVERS, (event: IpcMainInvokeEvent) => {
    if (!safeOwner(event)) throw new Error("MCP_FORBIDDEN");
    try { return listMcpServers(); } catch { throw new Error("MCP_LIST_FAILED"); }
  });
}
