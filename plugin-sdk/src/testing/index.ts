/**
 * 插件测试工具：不依赖 Firefly 宿主，就能在本地检查插件是否满足基本契约。
 *
 * - createMockPluginContext：返回一个可以事后检查的 PluginContext 替身
 * - assertPluginTool / assertValidManifest：发布前的契约断言
 */
import type { PluginContext, PluginCleanup, PluginChannelAdapter, PluginDeps, PluginEvents, PluginPromptProvider, PluginStorage, PluginTool } from "../api";
import { validateManifestData } from "../validate-manifest";

/** 一条事件订阅记录，测试可据此确认插件监听了什么。 */
interface RecordedSubscription {
  event: string;
  listener: (payload: unknown) => void | Promise<void>;
}

type IpcHandler = (...args: unknown[]) => unknown;

export interface MockPluginContext extends PluginContext {
  /** 通过 registerTool 登记的工具（浅拷贝），顺序与登记顺序一致。 */
  readonly tools: PluginTool[];
  /** 通过 registerPromptProvider 登记的 Provider。 */
  readonly promptProviders: PluginPromptProvider[];
  /** registerIpc 登记的 channel 名与处理函数。 */
  readonly ipcChannels: Map<string, IpcHandler>;
  /** 插件通过 events.emit 发布过的事件。 */
  readonly emittedEvents: Array<{ event: string; payload: unknown }>;
  /** events.on 的订阅记录；测试可以自己向 listener 派发 payload。 */
  readonly subscriptions: RecordedSubscription[];
  /** onDispose 登记的清理回调，顺序与登记顺序一致。 */
  readonly cleanups: PluginCleanup[];
  /** 模拟宿主停止插件：先触发 signal，再按逆序执行清理回调。 */
  dispose(): Promise<void>;
}

export interface MockPluginContextOptions {
  /** 默认 "mock-plugin"，用来决定工具 id 前缀等命名空间。 */
  pluginId?: string;
  /** 要注入的宿主服务，缺省为空对象，即所有能力都不可用。 */
  deps?: PluginDeps;
}

/** 从数组里删掉第一个满足条件的元素；找不到就抛出 notFound 给出的错误。 */
function removeFirst<T>(items: T[], predicate: (item: T) => boolean, notFound: () => string): void {
  const position = items.findIndex(predicate);
  if (position === -1) throw new Error(notFound());
  items.splice(position, 1);
}

/** 内存版的插件私有存储。 */
function createMemoryStorage(): PluginStorage {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    set: <T>(key: string, value: T) => {
      data.set(key, value);
    },
    rootDir: () => "/mock/plugin-data",
  };
}

export function createMockPluginContext(options: MockPluginContextOptions = {}): MockPluginContext {
  const tools: PluginTool[] = [];
  const promptProviders: PluginPromptProvider[] = [];
  const ipcChannels = new Map<string, IpcHandler>();
  const emittedEvents: Array<{ event: string; payload: unknown }> = [];
  const subscriptions: RecordedSubscription[] = [];
  const cleanups: PluginCleanup[] = [];
  const abortController = new AbortController();
  let stopped = false;

  /** 插件停止之后，登记类操作一律拒绝。 */
  const requireRunning = (what: string): void => {
    if (stopped) throw new Error(`插件停止后不能再${what}`);
  };

  const events: PluginEvents = {
    on(event, listener) {
      requireRunning("订阅事件");
      const entry: RecordedSubscription = {
        event,
        listener: listener as RecordedSubscription["listener"],
      };
      subscriptions.push(entry);
      return () => {
        const at = subscriptions.findIndex((s) => s.event === event && s.listener === listener);
        if (at !== -1) subscriptions.splice(at, 1);
      };
    },
    async emit(event, payload) {
      emittedEvents.push({ event, payload });
    },
  };

  const runCleanups = async (): Promise<void> => {
    // 与宿主保持一致：逆序执行，某一项失败不影响其余项
    const failures: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new Error(`清理回调抛出 ${failures.length} 个错误`);
  };

  return {
    id: options.pluginId ?? "mock-plugin",
    signal: abortController.signal,
    storage: createMemoryStorage(),
    deps: options.deps ?? {},
    events,
    // 以下是供测试检查的记录
    cleanups,
    subscriptions,
    emittedEvents,
    ipcChannels,
    promptProviders,
    tools,

    log() {
      /* 测试里默认不输出日志；需要时由调用方自行包装 */
    },

    onDispose(cleanup) {
      requireRunning("注册清理回调");
      cleanups.push(cleanup);
    },

    registerTool(tool) {
      requireRunning("注册工具");
      tools.push({ ...tool });
    },
    unregisterTool(toolId) {
      removeFirst(tools, (t) => t.id === toolId, () => `不能注销不属于当前插件的工具: ${toolId}`);
    },

    registerPromptProvider(provider) {
      requireRunning("注册提示词 Provider");
      promptProviders.push(provider);
    },
    unregisterPromptProvider(providerId) {
      removeFirst(
        promptProviders,
        (p) => p.id === providerId,
        () => `不能注销不属于当前插件的提示词 Provider: ${providerId}`,
      );
    },

    registerIpc(channel, handler) {
      requireRunning("注册 IPC channel");
      if (ipcChannels.has(channel)) throw new Error(`插件 IPC channel 已注册: ${channel}`);
      ipcChannels.set(channel, handler);
    },
    unregisterIpc(channel) {
      if (ipcChannels.delete(channel)) return;
      throw new Error(`不能注销不属于当前插件的 IPC channel: ${channel}`);
    },

    async registerChannelAdapter(adapter: PluginChannelAdapter) {
      throw new Error(`Mock Context 不支持注册渠道（${adapter.id}）：请使用真实宿主验证渠道插件`);
    },
    async unregisterChannelAdapter(channelId) {
      throw new Error(`Mock Context 未注册任何渠道: ${channelId}`);
    },

    async dispose() {
      if (stopped) return;
      stopped = true;
      abortController.abort();
      await runCleanups();
    },
  };
}

/**
 * 工具契约断言：覆盖宿主 registerTool 会拒绝的常见问题。
 * 所有问题收集完再一起抛出，插件作者一次就能改完。
 */
export function assertPluginTool(tool: PluginTool, pluginId: string): void {
  const issues: string[] = [];
  const prefix = `${pluginId}_`;

  if (!tool.id.startsWith(prefix)) issues.push(`工具 id 必须以 "${prefix}" 开头: ${tool.id}`);
  if (!tool.name) issues.push("工具缺少 name");
  if (!tool.description) issues.push(`工具 ${tool.id} 缺少 description`);
  if (tool.inputSchema?.type !== "object") {
    issues.push(`工具 ${tool.id} 的 inputSchema.type 必须是 "object"`);
  }
  if (typeof tool.execute !== "function") issues.push(`工具 ${tool.id} 的 execute 必须是函数`);

  if (issues.length) {
    throw new Error(["插件工具契约不满足:", ...issues.map((line) => `- ${line}`)].join("\n"));
  }
}

/** Manifest 契约断言：检查结构、类型、枚举与必填字段，不合法时抛出便于阅读的错误。 */
export function assertValidManifest(data: unknown): void {
  const { ok, error } = validateManifestData(data);
  if (ok) return;
  throw new Error(error ?? "manifest 结构不合法");
}
