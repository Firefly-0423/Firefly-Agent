import type { PluginEventBus } from "./events";
import { qualifyPluginEvent } from "./events";
import { createPluginStorage } from "./storage";
import type { PluginChannelAdapter, PluginContext, PluginDeps, PluginLlmService, PluginManifest, PluginPromptProvider, PluginTool, } from "./types";
import type { PluginPromptRegistry } from "./prompts";
import type { PluginResourceTracker } from "./resources";
import { createPluginResourceTracker } from "./resources";
export { PLUGIN_CLEANUP_TIMEOUT_MS, runPluginCleanup } from "./cleanup";
const LOCAL_CHANNEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SERVICE_FIELDS: Record<string, keyof PluginDeps> = Object.fromEntries(["channels", "llm", "secrets", "workspace", "conversations", "scheduler"].map((capabilityName) => [capabilityName, capabilityName as keyof PluginDeps]));
export type PluginHostServiceFactory = {
    createForPlugin(input: {
        trackResource: PluginResourceTracker;
        signal: AbortSignal;
        pluginId: string;
    }): PluginDeps;
};
export type PluginRuntime = {
    llm?: PluginLlmService;
    hostServices?: PluginHostServiceFactory;
    promptRegistry: Pick<PluginPromptRegistry, "register" | "unregister">;
    unregisterIpc: (channelName: string) => void;
    registerIpc: (channelName: string, callback: (...values: unknown[]) => unknown) => void;
    channelManager: {
        startOne(ownerId: string): Promise<void>;
        unregister(ownerId: string): Promise<boolean>;
        register(channelAdapter: PluginChannelAdapter): void;
        has(ownerId: string): boolean;
    };
    toolRegistry: {
        getById?(ownerId: string): {
            id: string;
        } | undefined;
        unregister(ownerId: string): boolean;
        register(definition: PluginTool): void;
    };
};
type DisposableContext = PluginContext & {
    dispose(): Promise<void>;
    beginStop(): void;
};
function tagLlmRequests(hostService: PluginLlmService, ownerId: string): PluginLlmService {
    const purposeLabel = (requestPurpose?: string): string => (requestPurpose ? `${ownerId}:${requestPurpose}` : ownerId);
    const taggedService: PluginLlmService = {
        generateText: (messages, options) => hostService.generateText(messages, { ...options, purpose: purposeLabel(options?.purpose) }),
    };
    if (hostService.runGoal)
        taggedService.runGoal = hostService.runGoal;
    return taggedService;
}
export function createContext(ownerId: string, privateDirectory: string, host: PluginRuntime, bus: Pick<PluginEventBus, "on" | "emit">, requirements?: PluginManifest["deps"]): DisposableContext {
    const cleanupFailures: unknown[] = [];
    const resources = createPluginResourceTracker((_kind, _key, failure) => {
        cleanupFailures.push(failure);
    });
    const cancellation = new AbortController();
    let closing = false;
    let closed = false;
    let resourceSequence = 0;
    let disposal: Promise<void> | undefined;
    const offeredServices: PluginDeps = host.hostServices
        ? host.hostServices.createForPlugin({
            pluginId: ownerId,
            signal: cancellation.signal,
            trackResource: resources,
        })
        : {
            channels: { has: (registeredChannelId) => host.channelManager.has(registeredChannelId) },
            ...(host.llm ? { llm: host.llm } : {}),
        };
    const injectedServices: PluginDeps = {};
    for (const capabilityName of requirements ?? []) {
        const serviceName = SERVICE_FIELDS[capabilityName];
        const hostService = offeredServices[serviceName];
        if (!hostService)
            throw new Error(`宿主未提供已声明的依赖: ${capabilityName}`);
        (injectedServices as Record<string, unknown>)[serviceName] =
            serviceName === "llm" ? tagLlmRequests(hostService as PluginLlmService, ownerId) : hostService;
    }
    const assertAccepting = (operation: string): void => {
        if (closing || closed)
            throw new Error(`插件停止后不能再${operation}`);
    };
    const resourceKey = (namespace: string): string => `${namespace}-${++resourceSequence}`;
    const assertResourceOwner = (category: string, resourceId: string, resourceLabel: string): void => {
        if (resources.has(category, resourceId))
            return;
        throw new Error(`不能注销不属于当前插件的${resourceLabel}: ${resourceId}`);
    };
    const pluginContext: PluginContext = {
        id: ownerId,
        signal: cancellation.signal,
        onDispose(cleanupCallback) {
            if (typeof cleanupCallback !== "function")
                throw new Error("插件清理回调必须是函数");
            assertAccepting("注册清理回调");
            resources.track("onDispose", resourceKey("dispose"), cleanupCallback);
        },
        events: {
            on(eventName, subscriber) {
                assertAccepting("订阅事件");
                const resourceId = resourceKey("subscription");
                const unsubscribe = bus.on(eventName, subscriber as (payload: unknown) => void | Promise<void>);
                resources.track("event-subscription", resourceId, () => {
                    unsubscribe();
                });
                return () => {
                    try {
                        unsubscribe();
                    }
                    finally {
                        resources.forget("event-subscription", resourceId);
                    }
                };
            },
            emit(eventName, payload) {
                return bus.emit(qualifyPluginEvent(ownerId, eventName), payload);
            },
        },
        registerTool(definition) {
            const unsupportedModes = definition.modes !== undefined
                && (!Array.isArray(definition.modes) || definition.modes.some((mode) => mode !== "work" && mode !== "code"));
            if (unsupportedModes)
                throw new Error("INVALID_TOOL_MODES");
            const namespace = `${ownerId}_`;
            if (!definition.id.startsWith(namespace)) {
                throw new Error(`插件工具 id 必须以 "${namespace}" 开头: ${definition.id}`);
            }
            assertAccepting("注册工具");
            if (resources.has("tool", definition.id))
                throw new Error(`插件工具 id 已由当前插件注册: ${definition.id}`);
            if (host.toolRegistry.getById?.(definition.id))
                throw new Error(`插件工具 id 已被占用: ${definition.id}`);
            host.toolRegistry.register(definition);
            resources.track("tool", definition.id, () => {
                host.toolRegistry.unregister(definition.id);
            });
        },
        unregisterTool(registeredToolId) {
            assertResourceOwner("tool", registeredToolId, "工具");
            host.toolRegistry.unregister(registeredToolId);
            resources.forget("tool", registeredToolId);
        },
        registerPromptProvider(contribution) {
            assertAccepting("注册提示词 Provider");
            host.promptRegistry.register(ownerId, contribution, cancellation.signal);
            resources.track("prompt-provider", contribution.id, () => {
                host.promptRegistry.unregister(ownerId, contribution.id);
            });
        },
        unregisterPromptProvider(registeredProviderId) {
            assertResourceOwner("prompt-provider", registeredProviderId, "提示词 Provider");
            host.promptRegistry.unregister(ownerId, registeredProviderId);
            resources.forget("prompt-provider", registeredProviderId);
        },
        registerIpc(channelName, callback) {
            if (!LOCAL_CHANNEL_NAME.test(channelName))
                throw new Error(`非法插件 IPC channel: ${channelName}`);
            assertAccepting("注册 IPC channel");
            const qualifiedChannel = `plugin:${ownerId}:${channelName}`;
            if (resources.has("ipc", qualifiedChannel))
                throw new Error(`插件 IPC channel 已注册: ${channelName}`);
            host.registerIpc(qualifiedChannel, callback);
            resources.track("ipc", qualifiedChannel, () => {
                host.unregisterIpc(qualifiedChannel);
            });
        },
        unregisterIpc(channelName) {
            const qualifiedChannel = `plugin:${ownerId}:${channelName}`;
            if (!resources.has("ipc", qualifiedChannel))
                throw new Error(`不能注销不属于当前插件的 IPC channel: ${channelName}`);
            host.unregisterIpc(qualifiedChannel);
            resources.forget("ipc", qualifiedChannel);
        },
        async registerChannelAdapter(channelAdapter) {
            assertAccepting("注册渠道");
            if (resources.has("channel-adapter", channelAdapter.id)) {
                throw new Error(`插件渠道 id 已由当前插件注册: ${channelAdapter.id}`);
            }
            if (host.channelManager.has(channelAdapter.id))
                throw new Error(`插件渠道 id 已被占用: ${channelAdapter.id}`);
            host.channelManager.register(channelAdapter);
            try {
                await host.channelManager.startOne(channelAdapter.id);
            }
            catch (failure) {
                await host.channelManager.unregister(channelAdapter.id);
                throw failure;
            }
            resources.track("channel-adapter", channelAdapter.id, async () => {
                await host.channelManager.unregister(channelAdapter.id);
            });
        },
        async unregisterChannelAdapter(registeredChannelId) {
            assertResourceOwner("channel-adapter", registeredChannelId, "渠道");
            try {
                await host.channelManager.unregister(registeredChannelId);
            }
            finally {
                resources.forget("channel-adapter", registeredChannelId);
            }
        },
        deps: injectedServices,
        storage: createPluginStorage(privateDirectory),
        log: (...values: unknown[]) => console.log(`[plugin:${ownerId}]`, ...values),
    };
    function beginStop(): void {
        if (closing || closed)
            return;
        closing = true;
        cancellation.abort();
    }
    const dispose = (): Promise<void> => {
        disposal ??= (async () => {
            beginStop();
            try {
                await resources.dispose();
            }
            finally {
                closed = true;
                const failureCount = cleanupFailures.length;
                if (failureCount)
                    console.warn(`[plugin:${ownerId}] 清理资源时发生 ${failureCount} 个错误`, cleanupFailures);
            }
        })();
        return disposal;
    };
    return Object.assign(pluginContext, { beginStop, dispose });
}
