import path from "node:path";
import { recordPluginCall } from "../storage/token-usage-store";
import type { PluginLlmService } from "../../plugins/api";
import type { PluginHostServiceFactory } from "../../plugins/context";
import {
  createPluginConversationsService,
  type PluginChatsStoreReader,
} from "./conversations-service";
import { createPluginSchedulerService, type PluginSchedulerStore } from "./scheduler-service";
import { createPluginSecretsService, type SafeStorageLike } from "./secrets-service";
import {
  createPluginWorkspaceService,
  type PluginWorkspaceStoreReader,
} from "./workspace-service";

/** 装配宿主服务所需的会话读取视图：会话列表、会话内容与工作区绑定。 */
export interface PluginHostChatsReader
  extends PluginChatsStoreReader, PluginWorkspaceStoreReader {}

export interface PluginHostServicesOptions {
  /** plugin-data 根目录，每个插件的密钥位于 <根>/<pluginId>/secrets/。 */
  pluginDataRoot: string;
  channelManager: { has(channelId: string): boolean };
  /** 共享的 LLM 服务；purpose 前缀由框架按插件 id 统一包装。 */
  llm: PluginLlmService;
  /** 可选的无头目标运行器工厂；不提供时保持旧宿主的行为。 */
  createAgentRunner?: (input: {
    pluginId: string;
    signal: AbortSignal;
  }) => NonNullable<PluginLlmService["runGoal"]>;
  storage: SafeStorageLike;
  chatsReader: PluginHostChatsReader;
  /** 调度存储必须已完成 load()，否则插件写入会覆盖磁盘上的既有数据。 */
  schedulerStore: PluginSchedulerStore;
}

/** 单个插件的装配范围：身份与停止信号，所有服务共享同一份。 */
interface PluginScope {
  pluginId: string;
  signal: AbortSignal;
}

type ServiceBag = ReturnType<PluginHostServiceFactory["createForPlugin"]>;

function channelsFor(options: PluginHostServicesOptions): ServiceBag["channels"] {
  return {
    has: (channelId) => options.channelManager.has(channelId),
  };
}

/**
 * 包装共享 LLM：调用计数在这里完成，因为只有此处知道是哪个插件发起的调用。
 * runGoal 仅在运行器工厂给出结果时才挂上。
 */
function llmFor(
  options: PluginHostServicesOptions,
  scope: PluginScope,
  runGoal: NonNullable<PluginLlmService["runGoal"]> | undefined,
): ServiceBag["llm"] {
  const countingLlm: PluginLlmService = {
    ...options.llm,
    generateText: (messages, generateOptions) => {
      recordPluginCall(scope.pluginId);
      return options.llm.generateText(messages, generateOptions);
    },
  };
  if (runGoal) {
    countingLlm.runGoal = runGoal;
  }
  return countingLlm;
}

function secretsFor(options: PluginHostServicesOptions, scope: PluginScope): ServiceBag["secrets"] {
  return createPluginSecretsService({
    pluginId: scope.pluginId,
    secretsRoot: path.join(options.pluginDataRoot, scope.pluginId, "secrets"),
    storage: options.storage,
    signal: scope.signal,
  });
}

function workspaceFor(options: PluginHostServicesOptions, scope: PluginScope): ServiceBag["workspace"] {
  return createPluginWorkspaceService({
    reader: options.chatsReader,
    signal: scope.signal,
  });
}

function conversationsFor(options: PluginHostServicesOptions, scope: PluginScope): ServiceBag["conversations"] {
  return createPluginConversationsService({
    reader: options.chatsReader,
    signal: scope.signal,
  });
}

function schedulerFor(options: PluginHostServicesOptions, scope: PluginScope): ServiceBag["scheduler"] {
  return createPluginSchedulerService({
    pluginId: scope.pluginId,
    store: options.schedulerStore,
    signal: scope.signal,
  });
}

/**
 * 宿主服务工厂：为每个插件组装一套服务。新增服务时只在这里追加一个构造函数，
 * PluginContext 不需要为任何单独的服务增加特例。
 */
export function createHostServiceFactory(options: PluginHostServicesOptions): PluginHostServiceFactory {
  return {
    createForPlugin({ pluginId, signal }) {
      const scope: PluginScope = { pluginId, signal };
      // 运行器先于其他服务创建，行为与旧宿主保持一致。
      const runGoal = options.createAgentRunner?.({ pluginId, signal });
      return {
        channels: channelsFor(options),
        llm: llmFor(options, scope, runGoal),
        secrets: secretsFor(options, scope),
        workspace: workspaceFor(options, scope),
        conversations: conversationsFor(options, scope),
        scheduler: schedulerFor(options, scope),
      };
    },
  };
}
