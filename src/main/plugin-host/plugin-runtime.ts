import { app, dialog, safeStorage } from "electron";
import path from "node:path";
import { channelManager } from "../channels/manager";
import type { ChannelAdapter } from "../channels/adapters/base";
import type { ChannelId } from "../channels/types";
import * as chatsStore from "../chats/chats-store";
import { toolRegistry, type ToolDefinition } from "../orchestrator/tools/registry/tool-registry";
import { loadGeneralSettings, saveGeneralSettings } from "../settings/settings-facade";
import { loadModelSettings, resolveModelSettingsProfile } from "../settings/model-settings";
import { pluginGenerateText } from "./plugin-llm";
import { createPluginAgentRunner } from "./plugin-agent";
import { createHostServiceFactory } from "./host-services";
import type { PluginSchedulerStore } from "./scheduler-service";
import { installPluginPanelProtocol } from "../plugin-panel/plugin-panel-protocol";
import { createPluginIpcRouter } from "../../plugins/ipc-router";
import { PluginManager } from "../../plugins/manager";
import { PluginVersionStore } from "../../plugins/version-store";
import { pluginPromptRegistry } from "../../plugins/prompts";
import { MARKET_REGISTRY_URLS, MARKET_ZIP_URL_PREFIXES, createPluginMarketplaceService } from "./plugin-marketplace";
import { IPC } from "../../shared/ipc-channels";
import { registerPluginMarketplaceIpc } from "./plugin-marketplace-ipc";
import { guardPluginIpcHandler, isFromHostDocument, type PluginIpcHosts } from "./plugin-management-ipc-guard";
import type { LlmClient } from "../services/llm/llm-client";
import { enqueueLLMTask } from "../services/llm/llm-queue";
import type { IpcScope } from "../application/ipc-scope";
import type { AgentRuntime } from "../orchestrator/agent-runtime";

export type PluginRuntimeSchedulerStore = PluginSchedulerStore & { deleteTasksByOwner(pluginId: string): number };
export interface PluginRuntimeDeps {
  llmClient: LlmClient; ipc: IpcScope;
  agentRuntime: Pick<AgentRuntime, "buildOptions">;
  schedulerStore: PluginRuntimeSchedulerStore;
  onPluginRunningStateChange?: (pluginId: string, running: boolean) => void;
  getPanelHostWebContents?: () => Electron.WebContents | null;
  getMarketplaceHostWebContents?: () => Electron.WebContents | null;
}

function notifyHosts(manager: PluginManager, owners: PluginIpcHosts): void {
  const state = manager.overview();
  for (const recipient of new Set([owners.getManagementHost(), owners.getPanelHost()])) {
    if (recipient && !recipient.isDestroyed()) {
      try { recipient.send(IPC.PLUGINS_CHANGED, state); }
      catch (failure) { console.warn("[plugins] state notification failed", failure); }
    }
  }
}

function bindPanelCalls(deps: PluginRuntimeDeps, owners: PluginIpcHosts, manager: PluginManager, routing: ReturnType<typeof createPluginIpcRouter>): void {
  deps.ipc.handle(IPC.PLUGINS_PANEL_INVOKE,
    (event: Electron.IpcMainInvokeEvent, identity: unknown, channel: unknown, argumentsList: unknown) => {
      if (typeof identity !== "string" || typeof channel !== "string" || !Array.isArray(argumentsList)) {
        return { ok: false, error: "面板调用参数格式非法" };
      }
      if (!isFromHostDocument(event, owners.getPanelHost(), "settings")) return { ok: false, error: "面板调用来源窗口不受信任" };
      if (!manager.getSettingsPanelDir(identity)) return { ok: false, error: "插件面板未运行" };
      return routing.dispatch({ pluginId: identity, channel, args: argumentsList, caller: "panel" });
    });
}

export async function startPluginRuntime(deps: PluginRuntimeDeps): Promise<PluginManager> {
  const installedRoot = path.join(app.getPath("userData"), "plugins");
  const privateRoot = path.join(app.getPath("userData"), "plugin-data");
  const routing = createPluginIpcRouter();
  const owners: PluginIpcHosts = {
    getManagementHost: () => deps.getMarketplaceHostWebContents?.() ?? null,
    getPanelHost: () => deps.getPanelHostWebContents?.() ?? null,
  };
  // Boundary adapters retain plugin object identity; defaults belong to the host registries.
  const plugins = new PluginManager({
    versionStore: new PluginVersionStore(installedRoot),
    scanRoots: [{ path: path.join(__dirname, "..", "..", "plugins"), source: "builtin" }, { path: installedRoot, source: "user" }],
    storageRoot: privateRoot,
    onListChanged: () => notifyHosts(plugins, owners),
    runtime: {
      toolRegistry: {
        register: (definition) => toolRegistry.register(definition as ToolDefinition),
        unregister: (identity) => toolRegistry.unregister(identity),
        getById: (identity) => toolRegistry.getById(identity),
      },
      channelManager: {
        has: (identity) => channelManager.has(identity as ChannelId),
        register: (port) => channelManager.register(port as unknown as ChannelAdapter),
        unregister: (identity) => channelManager.unregister(identity as ChannelId),
        startOne: (identity) => channelManager.startOne(identity as ChannelId),
      },
      registerIpc: (name, handler) => {
        routing.register(name, handler);
        deps.ipc.handle(name, guardPluginIpcHandler(name, owners, (argumentsList) => routing.invokeRegistered(name, argumentsList)));
      },
      unregisterIpc: (name) => { routing.unregister(name); deps.ipc.removeHandler(name); },
      promptRegistry: pluginPromptRegistry,
      hostServices: createHostServiceFactory({
        pluginDataRoot: privateRoot,
        channelManager: { has: (identity) => channelManager.has(identity as ChannelId) },
        llm: { generateText: (messages, options) => pluginGenerateText(messages,
          resolveModelSettingsProfile(loadModelSettings()), deps.llmClient, enqueueLLMTask, options) },
        createAgentRunner: ({ pluginId, signal }) => createPluginAgentRunner({
          pluginId, pluginSignal: signal, userDataPath: app.getPath("userData"), agentRuntime: deps.agentRuntime,
        }),
        storage: safeStorage, chatsReader: chatsStore, schedulerStore: deps.schedulerStore,
      }),
    },
    loadEnabledMap: () => loadGeneralSettings().plugins,
    saveEnabledMap: (enabled) => saveGeneralSettings({ plugins: enabled }),
    cleanupPersistentResources: async (identity) => { deps.schedulerStore.deleteTasksByOwner(identity); },
    selectPluginZip: async () => {
      const selection = await dialog.showOpenDialog({ title: "导入流萤插件", properties: ["openFile"],
        filters: [{ name: "流萤插件包", extensions: ["zip"] }] });
      return selection.canceled ? undefined : selection.filePaths[0];
    },
    confirmPluginReplace: async (candidate) => {
      const changedSource = candidate.sourceChange
        ? `\n\n来源将从${candidate.sourceChange.from.kind === "bundled" ? "随附离线目录" : "本地 ZIP"}更改为在线目录：${candidate.sourceChange.to.sourceId}\n本次确认同时授权该插件的来源变更。完整重启后尝试新版本，启停设置与私有数据将保留。`
        : "";
      const selection = await dialog.showMessageBox({
        type: "warning", title: "替换已有插件", message: `用户插件 ${candidate.name}（${candidate.id}）已经存在。`,
        detail: `是否用 ZIP 中的 ${candidate.version} 版本替换现有程序？插件私有数据将保留。${changedSource}`,
        buttons: ["取消", "替换"], defaultId: 0, cancelId: 0, noLink: true,
      });
      return selection.response === 1;
    },
  });
  const marketplace = createPluginMarketplaceService({
    registryUrls: MARKET_REGISTRY_URLS, bundledDir: path.join(__dirname, "..", "..", "plugin-marketplace"),
    zipUrlPrefixes: MARKET_ZIP_URL_PREFIXES, cacheDir: path.join(app.getPath("userData"), "plugin-market-cache"),
    installZip: (archive, options) => plugins.installZip(archive, options),
  });
  registerPluginMarketplaceIpc({ ipc: deps.ipc, market: marketplace,
    getHostWebContents: () => deps.getMarketplaceHostWebContents?.() ?? null });
  if (deps.onPluginRunningStateChange) plugins.onRunningStateChange(deps.onPluginRunningStateChange);
  bindPanelCalls(deps, owners, plugins, routing);
  installPluginPanelProtocol((identity) => plugins.getSettingsPanelDir(identity));
  await plugins.start();
  return plugins;
}