/**
 * 插件 IPC 路由器。两种调用来源共用同一张 handler 表：
 * 渲染端直接 ipcMain.invoke("plugin:<id>:<channel>")，以及设置面板桥经
 * PLUGINS_PANEL_INVOKE 转发。校验、查找、失效与错误规范化只在这里维护一份。
 *
 * 安全：dispatch 收到的 pluginId 与 channel 都来自沙箱面板，不可信，
 * 必须先过语法校验再拼接完整通道名，防止构造出指向其他插件的通道；
 * handler 的注销由插件 dispose 链路负责，未运行插件的通道自然查不到。
 */
import { PLUGIN_ID_RE } from "./loader";

/** 与 context.ts 中 registerIpc 使用同一语法约束。 */
const IPC_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

type IpcHandler = (...args: unknown[]) => unknown;

export type PluginIpcDispatchInput = {
  caller: "ipc" | "panel";
  args: unknown[];
  channel: string;
  pluginId: string;
};

export type PluginIpcDispatchResult = { ok: false; error: string } | { ok: true; data: unknown };

export type PluginIpcRouter = {
  /** 面板路径的入口：校验后拼出通道名查表，并统一包装结果 */
  dispatch(input: PluginIpcDispatchInput): Promise<PluginIpcDispatchResult>;
  /** ipcMain.handle 路径的入口：按完整通道名直接查表执行 */
  invokeRegistered(fullChannel: string, args: unknown[]): unknown;
  /** 注销通道，插件 dispose 时调用 */
  unregister(fullChannel: string): void;
  /** 登记完整通道名（含 plugin: 前缀或管理通道）对应的 handler */
  register(fullChannel: string, handler: IpcHandler): void;
};

const fail = (error: string): PluginIpcDispatchResult => ({ ok: false, error });

export function createPluginIpcRouter(): PluginIpcRouter {
  const table = new Map<string, IpcHandler>();

  const register: PluginIpcRouter["register"] = (fullChannel, handler) => {
    if (table.has(fullChannel)) throw new Error(`插件 IPC channel 已注册: ${fullChannel}`);
    table.set(fullChannel, handler);
  };

  const unregister: PluginIpcRouter["unregister"] = (fullChannel) => {
    table.delete(fullChannel);
  };

  const invokeRegistered: PluginIpcRouter["invokeRegistered"] = (fullChannel, args) => {
    const handler = table.get(fullChannel);
    if (!handler) throw new Error(`插件 IPC channel 未注册或插件已停止: ${fullChannel}`);
    return handler(...args);
  };

  const dispatch: PluginIpcRouter["dispatch"] = async ({ pluginId, channel, args }) => {
    if (!PLUGIN_ID_RE.test(pluginId)) return fail("插件 id 非法");
    if (!IPC_SEGMENT_RE.test(channel)) return fail("非法插件 IPC channel");

    const handler = table.get(`plugin:${pluginId}:${channel}`);
    if (!handler) return fail(`插件通道未注册或插件未运行: ${channel}`);

    try {
      return { ok: true, data: await handler(...args) };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };

  return { register, unregister, invokeRegistered, dispatch };
}
