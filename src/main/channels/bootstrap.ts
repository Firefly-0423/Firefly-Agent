import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { IpcScope } from "../application/ipc-scope";
import { IPC } from "../../shared/ipc-channels";
import type { PluginPromptMode, PluginTurnStatus } from "../../plugins/api";
import type { RunFinishedEvent } from "@ag-ui/core";
import { loadModelSettings, resolveModelSettingsProfile } from "../settings/model-settings";
import { resolveDefaultModelProfile } from "../settings/model-catalog";
import { requireChannelMemoryIngress, type ChannelsMemoryHost } from "../memory-context/channel-memory-ingress";
import type { LifecyclePublisher } from "../plugin-host/lifecycle-publisher";
import { FireflyAgent } from "../orchestrator/firefly-agent";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { captionImageSafe, IMAGE_CAPTION_PROMPT } from "../chat/image-caption";
import { resolveCaptionVisionConfig, resolveImageRoute } from "../orchestrator/image-router";
import { indexConversationTurn } from "../orchestrator/tools/history-tools";
import type { AgentRuntime } from "../orchestrator/agent-runtime";
import { buildChannelAttachmentInputs } from "./agent-input";
import { loadChannelsSettings } from "./settings-store";
import { enforceChannelAgentPolicy, resolveChannelAgentPolicy } from "./agent-policy";
import { appendMessage, getSession, listSessions } from "../chats/chats-store";
import { getChannelConversationBindingStore } from "./conversation-binding-store";
import { ChannelDispatcher, type ChannelAgentResult, type DispatcherDeps } from "./dispatcher";
import { createChannelContext, formatChannelUserText, type BoundConversationMessageMetadata, } from "./channel-context";
import { appendHistory, migrateHistory } from "./history-log";
import { createKeyedQueue } from "./keyed-queue";
import { createChannelRateLimiter } from "./rate-limiter";
import { createChannelDeliveryService } from "./delivery-service";
import { createOutgoingComposer, type OutgoingComposer, } from "./outgoing-composer";
import { channelManager } from "./manager";
import { initializeChannels, startChannels, shutdownChannels, } from "./init";

export interface ChannelsLifecycleAdapter {
  shutdown(): Promise<void>;
  start(signal?: AbortSignal): Promise<void>;
  initialize(): void;
}
export interface ChannelsSubsystem {
  shutdown(): Promise<void>;
  adaptersRegistered: Promise<void>;
  start(signal?: AbortSignal): Promise<void>;
  initialize(): void;
}
export type ChannelsSubsystemDeps = {
  publishLifecycle?: LifecyclePublisher;
  ipc?: IpcScope;
  getReactChatWindow: () => BrowserWindow | null;
  memory?: ChannelsMemoryHost;
  agentRuntime: AgentRuntime;
};
export function createChannelsSubsystem(deps: ChannelsSubsystemDeps, lifecycle?: ChannelsLifecycleAdapter): ChannelsSubsystem {
  const readChannelHistory = async (identifier: string, count: number) => {
    const module = await import("./history-log");
    return module.loadRecentHistory(identifier, count);
  };
  const observe: DispatcherDeps["observeExternalChat"] = (identifier, message) => {
    getChannelConversationBindingStore().observe({ sessionId: identifier, channel: message.channel, chatId: message.chatId,
      chatType: message.chatType ?? "private", ...(message.senderName ? { senderName: message.senderName } : {}), lastAt: message.at.getTime() });
  };
  const resolveBinding = (identifier: string): string | null => {
    const conversation = getChannelConversationBindingStore().resolve(identifier);
    return conversation && listSessions().some((entry) => entry.id === conversation) ? conversation : null;
  };
  const readConversation = async (identifier: string, count: number) => {
    const conversation = getSession(identifier);
    if (!conversation) return [];
    return conversation.messages.filter((entry) => (entry.role === "user" || entry.role === "model") && entry.content.trim().length > 0)
      .slice(-count).map((entry) => ({ role: entry.role === "model" ? "assistant" as const : "user" as const, content: entry.modelContext?.trim() || entry.content }));
  };
  const mirrorMessage = (identifier: string, role: "user" | "assistant", content: string, metadata: BoundConversationMessageMetadata) => {
    const updated = appendMessage(identifier, {
      id: randomUUID(), role: role === "assistant" ? "model" : "user", content, at: Date.now(), modelContext: metadata.modelContext, sticker: metadata.sticker,
      channelSource: { channel: metadata.channel, chatType: metadata.chatType, senderName: metadata.senderName },
    });
    if (!updated) throw new Error("Bound conversation no longer exists");
    const window = deps.getReactChatWindow();
    if (window && !window.isDestroyed()) {
      try { window.webContents.send(IPC.CHATS_CHANGED); }
      catch (failure) { console.warn("[Channels] bound conversation refresh failed:", failure); }
    }
  };
  const run: DispatcherDeps["buildAndRunAgent"] = async (message, identifier, prior, ingress) => {
    if (deps.memory && !ingress) throw Error("MEMORY_CHANNEL_ACCOUNT_UNAVAILABLE");
    const authority = deps.memory ? requireChannelMemoryIngress(ingress, message) : undefined;
    if (authority && authority.sessionId !== identifier) throw Error("MEMORY_CHANNEL_INGRESS_DENIED");
    const result: ChannelAgentResult = { text: "", sticker: null };
    const sandbox = loadChannelsSettings().toolSandbox;
    const policy = resolveChannelAgentPolicy(sandbox, { channel: message.channel, chatType: message.chatType });
    const registeredTools = toolRegistry.getEnabledTools();
    const permittedTools = policy.exposeTools ? registeredTools : [];
    console.log("[Channels] bot run:", `msg.channel=${message.channel} sandbox=${sandbox} tools=${permittedTools.length}/${registeredTools.length} priorMsgs=${prior?.length ?? 0}`);
    const history = (deps.memory ? [] : prior ?? []).filter((entry) => typeof entry.content === "string" && entry.content.trim().length > 0)
      .map((entry) => ({ role: entry.role as "user" | "assistant" | "system", content: entry.content }));
    const saved = loadModelSettings();
    const profile = deps.memory ? resolveDefaultModelProfile(saved.modelProfiles ?? [], saved.defaultModelProfileId)?.id : undefined;
    if (deps.memory && !profile) throw Error("MEMORY_RUN_PROFILE_DENIED");
    const userText = formatChannelUserText(message);
    const runId = randomUUID();
    const userTurnId = deps.memory ? randomUUID() : `${message.channel}:${message.senderId}:${message.at.toISOString()}:user`;
    const assistantTurnId = deps.memory ? randomUUID() : `${message.channel}:${message.senderId}:${message.at.toISOString()}:assistant`;
    const preparedMemory = deps.memory ? await deps.memory.prepareRun({ ingress: ingress!, message, userText,
      modelProfileId: profile!, runId, userTurnId, assistantTurnId, signal: authority!.signal }) : undefined;
    try {
      if (preparedMemory && (preparedMemory.sessionId !== identifier || preparedMemory.signal.aborted)) throw Error("MEMORY_CHANNEL_INGRESS_DENIED");
      const model = resolveModelSettingsProfile(saved);
      const imageRoute = resolveImageRoute("channel", model);
      const media = deps.memory ? {} : await buildChannelAttachmentInputs(message, {
        imageMode: imageRoute.mode === "direct" ? "direct" : "caption",
        captionImage: async (filename: string) => {
          const current = resolveModelSettingsProfile(loadModelSettings());
          const vision = resolveCaptionVisionConfig(current);
          if (!vision.ok) return { ok: false, error: vision.error };
          return captionImageSafe(filename, IMAGE_CAPTION_PROMPT, vision.config);
        },
      });
      const request: Parameters<AgentRuntime["buildOptions"]>[0] = {
        messages: [...history, { role: "user", content: userText }], sessionId: identifier, ...(profile ? { modelProfileId: profile } : {}),
        workspaceBindingSessionId: null, attachments: media.attachments, imageAttachments: media.imageAttachments,
        channel: message.channel, executionMode: policy.executionMode, ...(deps.memory || policy.executionMode === "chat" ? { userTurnId, assistantTurnId } : {}),
      };
      const { options } = preparedMemory ? await deps.agentRuntime.buildOptions(request, { attachmentGrant: preparedMemory.attachmentGrant }) : await deps.agentRuntime.buildOptions(request);
      options.tools = policy.exposeTools ? [...(options.capabilities?.tools ?? permittedTools)] : [];
      enforceChannelAgentPolicy(options, policy);
      if (preparedMemory) Object.assign(options, { runId, conversationId: identifier, userTurnId, assistantTurnId,
        signal: preparedMemory.signal, transcriptSink: preparedMemory.transcriptSink, openMemoryRun: preparedMemory.openMemoryRun });
      const thread = `thread-${identifier}-${Date.now()}`;
      const agent = new FireflyAgent({ threadId: thread, description: `bot:${message.channel}:${message.senderId}` });
      const mode: PluginPromptMode = options.conversationMode ?? (options.executionMode === "chat" ? "chat" : "work");
      const startedAt = Date.now();
      deps.publishLifecycle?.publishTurnStarted({ source: "channel", channel: message.channel, conversationId: identifier, runId, mode });
      let status: PluginTurnStatus = "runtime_error";
      try {
        let finished: RunFinishedEvent | undefined;
        const reply = await new Promise<string>((accept, fail) => {
          agent.runWithEvents(options).subscribe({
            next: (event) => { if (event.type === "RUN_FINISHED") finished = event as RunFinishedEvent; },
            complete: () => { accept(agent.lastResult?.reply ?? ""); },
            error: (failure) => fail(failure instanceof Error ? failure : new Error(String(failure))),
          });
        });
        const terminal = finished?.result ?? agent.lastResult?.terminal ?? { status: "success", externalEffectsMayContinue: false };
        result.terminal = terminal;
        status = terminal.status;
        result.text = reply;
        if (agent.lastResult && status === "success") {
          const completion = await deps.agentRuntime.onRunFinished(agent.lastResult, userText, { source: "channel", mode, conversationId: identifier, channel: message.channel });
          result.sticker = completion.sticker;
        }
        if (!deps.memory && status === "success") void indexConversationTurn(identifier, userText, reply);
        return result;
      } finally {
        deps.publishLifecycle?.publishTurnFinished({ source: "channel", channel: message.channel, conversationId: identifier, runId, mode, status, durationMs: Date.now() - startedAt });
      }
    } finally { await preparedMemory?.close(); }
  };
  const broadcast: DispatcherDeps["broadcastChat"] = (event) => {
    const window = deps.getReactChatWindow();
    if (!window || window.isDestroyed()) return;
    try { window.webContents.send(IPC.AGUI_EVENT, { type: "CUSTOM", name: "firefly.botMessage", value: event }); }
    catch (failure) { console.warn("[Channels] botMessage 广播失败:", failure); }
  };
  const context = createChannelContext({ resolveBoundConversationId: resolveBinding, loadRecentChannelHistory: readChannelHistory,
    loadBoundConversationHistory: readConversation, appendChannelHistory: appendHistory, appendBoundConversationMessage: mirrorMessage, migrateHistory });
  const outgoing = createOutgoingComposer();
  const composer: OutgoingComposer = {
    compose: (request) => outgoing.compose({ ...request, capability: channelManager.getAdapter(request.incoming.channel)?.capability }),
    cleanupTransientFiles: (files) => outgoing.cleanupTransientFiles(files),
  };
  const limiter = createChannelRateLimiter({ limits: { perUser: Number.MAX_SAFE_INTEGER, perChannel: Number.MAX_SAFE_INTEGER } });
  const dispatcher = new ChannelDispatcher({ queue: createKeyedQueue({ maxPendingPerKey: 20 }), limiter, context, composer,
    delivery: createChannelDeliveryService(channelManager), buildAndRunAgent: run, memoryEnabled: !!deps.memory,
    loadSettings: loadChannelsSettings, observeExternalChat: observe, broadcastChat: broadcast });
  const defaultLifecycle: ChannelsLifecycleAdapter = {
    initialize: () => initializeChannels({ ipc: deps.ipc, handleIncoming: (message, ingress) => dispatcher.handleIncoming(message, ingress), reloadDispatcherSettings: () => dispatcher.reloadSettings() }),
    start: (signal?: AbortSignal) => startChannels(signal), shutdown: () => shutdownChannels(),
  };
  const lifecycleAdapter = lifecycle ?? defaultLifecycle;
  let markRegistered!: () => void;
  let markFailed!: (error: unknown) => void;
  const registered = new Promise<void>((accept, fail) => { markRegistered = accept; markFailed = fail; });
  return {
    initialize: () => {
      try { lifecycleAdapter.initialize(); markRegistered(); }
      catch (failure) { markFailed(failure); throw failure; }
    },
    start: (signal?: AbortSignal) => lifecycleAdapter.start(signal),
    adaptersRegistered: registered,
    shutdown: async () => { try { await lifecycleAdapter.shutdown(); } finally { getChannelConversationBindingStore().flush(); } },
  };
}
