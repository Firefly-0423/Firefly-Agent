import {createAttachmentDocumentMaterializer} from "../memory-context/attachment-document-materializer";
import type {BackgroundMemoryHost} from "../memory-context/background-memory-ingress";
import type {MainMemoryRun} from "../memory-context/main-memory-runtime";
import { app } from "electron";
import {copyControlledStreamTarget} from "./controlled-responses";
import type {ChatRequest} from "./vendors/types";
import type {AgentLoopResult} from "./firefly-agent";
import {copyMainResponsesRequest} from "./vendors/response-request-snapshot";
import type {MainSRuntimePort,MainSRuntimeInput,MainSRuntimeResult} from "../memory-context/main-s-runtime-port";
import { loadPromptFile } from "../prompts/prompt-loader";
import type { AguiRunInput, BuildOptionsFn, MainBuildOptionsContext } from "../agui-bridge";
import type { ScheduledTask } from "../scheduler/types";
import type { ChannelId } from "../channels/types";
import type { ModelSettings } from "../settings/model-settings";
import type { GeneralSettings } from "../settings/general-settings";
import type { UserProfile } from "../settings-store";
import { resolveCaptionVisionConfig } from "./image-router";
import { getTimeoutSettings } from "../timeout-manager";
import { resolveModelSettingsProfile, getDefaultModelProfile } from "../settings/model-settings";
import { normalizeChatMessages } from "../chat/chat-api-utils";
import { captionImageSafe, IMAGE_CAPTION_PROMPT } from "../chat/image-caption";
import { buildEnvironmentContext } from "./environment";
import { buildToneInjection } from "./tone-injector";
import { buildAlwaysOnContext, buildWorldbookContext, scheduleMemoryWrite } from "./index";
import { matchSticker } from "../stickers/sticker-embedder";
import { buildRelationshipContext, recordRelationshipTurn } from "../relationship/relationship-log";
import { compileSocialContextBlock } from "../social-context/context";
import { rankSocialAtoms } from "../social-context/retrieval";
import {
  buildSkillCatalog,
  buildAutoInjectedSkillContext,
  buildAutoInjectedSoulContext,
  skillRegistry,
} from "../skills";
import { resolveSlashActivation } from "../skills/slash-activation";
import type { SocialAtom, SocialExtractionInput } from "../social-context/types";
import type { ToolDefinition, ToolModeOverrides } from "./tools/registry/tool-registry";
import type { ConversationMode } from "../../shared/chat-types";
import {
  buildAgentRunOptions,
  onAgentRunFinished,
  type BuildOptionsDeps,
  type OnRunFinishedDeps,
} from "./build-options";
import { buildModelContext } from "./conversation-transcript-context";
import { getConversationTranscriptStore } from "./conversation-transcript-store";
import { getHarnessRunStore } from "./harness/run-store";
import { type FireflyRunResult, type FireflyRunOptions } from "./firefly-agent";
import type { HarnessToolFinishedEvent } from "./harness/types";
import type { ToolFinishedInput } from "../plugin-host/lifecycle-publisher";
import {
  buildToolSystemPrompt,
  buildSoulSystemBasePrompt,
} from "./system-prompt-builder";
import { buildModePrompt } from "./mode-prompt-profile";
import { resolveRunCapabilities } from "./run-capabilities";
import { loadStickerSettings } from "./sticker-settings";
import { loadUserStickerManifest } from "../stickers/sticker-storage";
import type { LlmClient } from "../services/llm/llm-client";
import type {
  PluginTurnCompletedEvent,
  PluginPromptBuildInput,
  PluginPromptMode,
} from "../../plugins/types";

export type AgentRuntimeDeps = {
  publishToolFinished?: (event: ToolFinishedInput) => void;
  publishPluginHostEvent: <T>(event: string, payload: T) => Promise<void>;
  buildPluginPromptContext: (input: PluginPromptBuildInput) => Promise<string>;
  socialAtomStore: { listActive: (conversationId: string, now: number) => SocialAtom[] };
  chatsStore: { getWorkspaceBinding: (conversationId: string) => { workspaceRoot: string; displayName: string; boundAt: number } | undefined };
  socialContextScheduler: { schedule: (input: SocialExtractionInput) => void };
  getEmbeddingProvider: () => unknown;
  getStickerEmbeddingIndex: () => unknown;
  skillRegistry: typeof skillRegistry;
  toolRegistry: { getEnabledTools: () => ToolDefinition[]; getEnabledToolsForMode: (mode: ConversationMode, overrides?: ToolModeOverrides) => ToolDefinition[]; };
  loadUserProfile: () => UserProfile;
  loadGeneralSettings: () => GeneralSettings;
  loadModelSettings: () => ModelSettings;
  llmClient: LlmClient;
  sContext?: {enabled?:boolean;isControlledSession?:(conversationId:string)=>boolean;createPort:(scope?:Readonly<{conversationId:string}>)=>MainSRuntimePort|Promise<MainSRuntimePort>;streamRequest?:(options:FireflyRunOptions)=>ChatRequest};
  defaultMemory?:{openRun:(input:FireflyRunOptions)=>Promise<MainMemoryRun>;prepareBackgroundRun?:BackgroundMemoryHost["prepareBackgroundRun"]};
};

export type AgentRunFinishedContext = {
  modelProfileId?: string;
  runId?: string;
  channel?: string;
  conversationId: string;
  mode: PluginPromptMode;
  source: PluginTurnCompletedEvent["source"];
};

export type AgentRuntime = {
  buildSchedulerOptions(task: ScheduledTask): Promise<SchedulerRunOptions>;
  onRunFinished(result: FireflyRunResult, latestUserText: string, context: AgentRunFinishedContext): Promise<{ sticker: string | null }>;
  buildOptions: BuildOptionsFn;
  runSContext(input:MainSRuntimeInput):Promise<MainSRuntimeResult>;
};

type SchedulerRunOptions = Omit<FireflyRunOptions, "toolSystemContent" | "soulSystemBaseContent">;

export function createAgentRuntime(rawDeps: AgentRuntimeDeps): AgentRuntime {
  const background: BackgroundMemoryHost | undefined = rawDeps.defaultMemory?.prepareBackgroundRun
    ? { prepareBackgroundRun: (request) => rawDeps.defaultMemory!.prepareBackgroundRun!(request) } : undefined;
  const retiredTools = new Set(["user_memory", "read_memory", "write_memory", "recall_history"]);
  const registry = rawDeps.defaultMemory ? {
    getEnabledTools: () => rawDeps.toolRegistry.getEnabledTools().filter((entry) => !retiredTools.has(entry.id)),
    getEnabledToolsForMode: (mode: ConversationMode, overrides?: ToolModeOverrides) => rawDeps.toolRegistry.getEnabledToolsForMode(mode, overrides).filter((entry) => !retiredTools.has(entry.id)),
  } : rawDeps.toolRegistry;
  const provisioned = new Map<string | undefined, Promise<MainSRuntimePort>>();
  function provisionSPort(conversationId?: string): Promise<MainSRuntimePort> {
    const configuration = rawDeps.sContext;
    if (configuration?.enabled !== true) throw Error("MEMORY_CONTEXT_RUNTIME_DISABLED");
    let pending = provisioned.get(conversationId);
    if (!pending) {
      const scope = conversationId === undefined ? undefined : Object.freeze({ conversationId });
      pending = Promise.resolve().then(() => configuration.createPort(scope));
      provisioned.set(conversationId, pending);
    }
    return pending;
  }
  function mainSessionId(input: AguiRunInput): string {
    const property = Object.getOwnPropertyDescriptor(input, "sessionId");
    if (!property || !("value" in property) || typeof property.value !== "string" || !property.value
      || property.value.length > 256 || /[\u0000-\u001f\u007f]/.test(property.value)) throw Error("MEMORY_CONTEXT_STREAM_TARGET_INVALID");
    return property.value;
  }
  function selectedSInput(injection: NonNullable<AgentRuntimeDeps["sContext"]>, input: AguiRunInput): boolean {
    const property = Object.getOwnPropertyDescriptor(injection, "isControlledSession");
    if (!property) return true;
    if (!("value" in property) || typeof property.value !== "function") throw Error("MEMORY_CONTEXT_STREAM_TARGET_INVALID");
    const selection = property.value(mainSessionId(input));
    if (typeof selection !== "boolean") throw Error("MEMORY_CONTEXT_STREAM_TARGET_INVALID");
    return selection;
  }
  async function prepareTranscript(input: AguiRunInput): Promise<void> {
    const configuration = rawDeps.sContext;
    if (configuration?.enabled !== true || !selectedSInput(configuration, input)) return;
    const factory = Object.getOwnPropertyDescriptor(configuration, "streamRequest");
    if (factory && !("value" in factory) || factory?.value !== undefined && typeof factory.value !== "function") throw Error("MEMORY_CONTEXT_STREAM_TARGET_INVALID");
    if (factory?.value !== undefined) await provisionSPort(mainSessionId(input));
  }
  async function runSContext(input: MainSRuntimeInput): Promise<MainSRuntimeResult> {
    const configuration = rawDeps.sContext;
    if (configuration?.enabled !== true) throw Error("MEMORY_CONTEXT_RUNTIME_DISABLED");
    const cancellationProperty = Object.getOwnPropertyDescriptor(input, "signal");
    if (cancellationProperty && !("value" in cancellationProperty)) throw Error("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
    const cancellation = cancellationProperty?.value as AbortSignal | undefined;
    if (cancellation?.aborted) throw Error("MEMORY_CONTEXT_CANCELLED");
    const requestProperty = Object.getOwnPropertyDescriptor(input, "request");
    if (!requestProperty || !("value" in requestProperty)) throw Error("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
    const targetProperty = Object.getOwnPropertyDescriptor(input, "stream");
    if (targetProperty && !("value" in targetProperty)) throw Error("MEMORY_CONTEXT_STREAM_TARGET_INVALID");
    const captured: MainSRuntimeInput = { request: copyMainResponsesRequest(requestProperty.value), signal: cancellation,
      ...(targetProperty?.value !== undefined ? { stream: copyControlledStreamTarget(targetProperty.value) } : {}) };
    const port = await provisionSPort(captured.stream?.conversationId);
    if (cancellation?.aborted) throw Error("MEMORY_CONTEXT_CANCELLED");
    return port.run(captured);
  }

  function optionDependencies(): BuildOptionsDeps {
    return {
      loadModelSettings: (profile?: string) => resolveModelSettingsProfile(rawDeps.loadModelSettings(), profile),
      loadGeneralSettings: () => rawDeps.loadGeneralSettings(),
      loadUserProfile: () => rawDeps.loadUserProfile(),
      buildEnvironmentContext: ((model, profile) => buildEnvironmentContext(model, profile as any)) as BuildOptionsDeps["buildEnvironmentContext"],
      buildSkillCatalog: ((entries) => buildSkillCatalog(entries as any)) as BuildOptionsDeps["buildSkillCatalog"],
      buildAutoInjectedSkillContext: ((entries) => buildAutoInjectedSkillContext(entries as any, (key) => rawDeps.skillRegistry.getBody(key))) as BuildOptionsDeps["buildAutoInjectedSkillContext"],
      buildAutoInjectedSoulContext: ((entries) => buildAutoInjectedSoulContext(entries as any, (key) => rawDeps.skillRegistry.getBody(key))) as BuildOptionsDeps["buildAutoInjectedSoulContext"],
      skillRegistry: {
        getEnabled: () => rawDeps.skillRegistry.getEnabled() as unknown[],
        getEnabledForMode: (mode, overrides) => rawDeps.skillRegistry.getEnabledForMode(mode, overrides) as unknown[],
        getBody: (key) => rawDeps.skillRegistry.getBody(key),
      },
      resolveSlashActivation: ((history, mode, overrides) => resolveSlashActivation(history as any, mode, overrides)) as BuildOptionsDeps["resolveSlashActivation"],
      buildToneInjection: (() => buildToneInjection()) as BuildOptionsDeps["buildToneInjection"],
      buildAlwaysOnContext: ((query, history) => (rawDeps.defaultMemory ? buildWorldbookContext : buildAlwaysOnContext)(query, history as any)) as BuildOptionsDeps["buildAlwaysOnContext"],
      buildRelationshipContext,
      buildModePrompt,
      buildToolSystemPrompt: ((mode, definitions) => buildToolSystemPrompt(mode, definitions as ToolDefinition[])) as BuildOptionsDeps["buildToolSystemPrompt"],
      buildSoulSystemBasePrompt,
      resolveRunCapabilities: ({ mode, activeSearchBackend, toolModeOverrides, skillModeOverrides, chatToolsEnabled }) => resolveRunCapabilities({
        mode, activeSearchBackend, toolModeOverrides, skillModeOverrides, chatToolsEnabled, toolRegistry: registry, skillRegistry: rawDeps.skillRegistry,
      }),
      toolRegistry: {
        getEnabled: () => registry.getEnabledTools() as unknown[],
        getEnabledToolsForMode: (mode: ConversationMode, overrides?: ToolModeOverrides) => registry.getEnabledToolsForMode(mode, overrides) as unknown[],
      },
      normalizeChatMessages: ((history) => normalizeChatMessages(history as any)) as BuildOptionsDeps["normalizeChatMessages"],
      chatRequestTimeoutMs: getTimeoutSettings().chatRequestTimeout,
      captionImageForFallback: async (location: string) => {
        const configuration = resolveModelSettingsProfile(rawDeps.loadModelSettings());
        const vision = resolveCaptionVisionConfig(configuration);
        if (!vision.ok) return { ok: false, error: vision.error };
        return captionImageSafe(location, IMAGE_CAPTION_PROMPT, vision.config);
      },
      buildChatSocialContext: async ({ conversationId, query }) => {
        const timestamp = Date.now();
        const active = rawDeps.socialAtomStore.listActive(conversationId, timestamp);
        const retrieved = rankSocialAtoms(query, active, { now: timestamp, limit: 5 });
        return { contextBlock: compileSocialContextBlock(retrieved), retrievedAtoms: retrieved };
      },
      getWorkspaceBinding: (conversation: string) => rawDeps.chatsStore.getWorkspaceBinding(conversation),
      buildPluginPromptContext: (request) => rawDeps.buildPluginPromptContext(request),
      buildModelContext: (conversationId, retainTokens) => buildModelContext({
        store: getConversationTranscriptStore(app.getPath("userData")), conversationId, retainTokens, runReader: getHarnessRunStore(app.getPath("userData")),
      }),
    };
  }
  function finishDependencies(profile?: string): OnRunFinishedDeps {
    return {
      loadModelSettings: () => resolveModelSettingsProfile(rawDeps.loadModelSettings(), profile),
      scheduleMemoryWrite,
      ...(rawDeps.defaultMemory ? { personalMemoryMode: "smh" as const } : {}),
      scheduleSocialAtomExtraction: (request) => rawDeps.socialContextScheduler.schedule(request),
      stickerEmbeddingIndex: rawDeps.getStickerEmbeddingIndex(),
      getEmbeddingProvider: (() => rawDeps.getEmbeddingProvider() as unknown) as OnRunFinishedDeps["getEmbeddingProvider"],
      matchSticker: ((text, provider, index, threshold) => matchSticker(text, provider as any, index as any, threshold) as Promise<{ id: string } | null | undefined>) as OnRunFinishedDeps["matchSticker"],
      loadStickerSettings,
      isCustomSticker: (key) => Object.prototype.hasOwnProperty.call(loadUserStickerManifest(), key),
      recordRelationshipTurn,
    };
  }
  const toolFinished = rawDeps.publishToolFinished ? (event: HarnessToolFinishedEvent) => rawDeps.publishToolFinished!(event) : undefined;

  const buildOptions = Object.assign(async (input: AguiRunInput, mainContext?: MainBuildOptionsContext) => {
    const configuration = rawDeps.sContext;
    let controlled: { scope: { conversationId?: string; userTurnId?: string; assistantTurnId?: string }; buildRequest: (options: FireflyRunOptions) => ChatRequest } | undefined;
    if (configuration?.enabled === true && selectedSInput(configuration, input)) {
      const factory = Object.getOwnPropertyDescriptor(configuration, "streamRequest");
      if (factory && !("value" in factory)) throw Error("MEMORY_CONTEXT_STREAM_TARGET_INVALID");
      if (factory?.value !== undefined) {
        if (typeof factory.value !== "function") throw Error("MEMORY_CONTEXT_STREAM_TARGET_INVALID");
        const readId = (key: "sessionId" | "userTurnId" | "assistantTurnId"): string | undefined => {
          const property = Object.getOwnPropertyDescriptor(input, key);
          if (property && !("value" in property) || property?.value !== undefined && typeof property.value !== "string") throw Error("MEMORY_CONTEXT_STREAM_TARGET_INVALID");
          return property?.value;
        };
        controlled = { scope: Object.freeze({ conversationId: readId("sessionId"), userTurnId: readId("userTurnId"), assistantTurnId: readId("assistantTurnId") }), buildRequest: factory.value };
      }
    }
    const dependencies = optionDependencies();
    if (rawDeps.defaultMemory) {
      dependencies.requireAttachmentGrant = true;
      dependencies.attachmentGrant = mainContext?.attachmentGrant;
      dependencies.materializeAttachmentDocument = createAttachmentDocumentMaterializer();
      dependencies.buildRelationshipContext = async () => "";
      dependencies.buildChatSocialContext = undefined;
    }
    if (controlled) {
      dependencies.buildAlwaysOnContext = async () => "";
      dependencies.buildRelationshipContext = async () => "";
      dependencies.buildChatSocialContext = async () => ({ contextBlock: "", retrievedAtoms: [] });
    }
    const built = await buildAgentRunOptions(input, dependencies);
    const next: FireflyRunOptions = { ...built.options, onToolFinished: toolFinished, ...(background ? { backgroundMemory: background } : {}),
      ...(rawDeps.defaultMemory ? { openMemoryRun: (current: FireflyRunOptions) => rawDeps.defaultMemory!.openRun(current) } : {}) };
    if (controlled) {
      const { scope, buildRequest } = controlled;
      next.controlledResponses = async (current, cancellation, notify) => {
        if (current.executionMode !== "chat" || current.tools?.length) throw Error("MEMORY_CONTEXT_STREAM_MODE_UNSUPPORTED");
        if (!scope.conversationId || !scope.userTurnId || !scope.assistantTurnId || !current.runId || !current.transcriptSink
          || !current.isControlledRunCurrent || current.conversationId !== scope.conversationId) throw Error("MEMORY_CONTEXT_STREAM_TARGET_INVALID");
        try {
          const response = await runSContext({ request: buildRequest(current), signal: cancellation, stream: {
            ...scope, conversationId: scope.conversationId, userTurnId: scope.userTurnId, assistantTurnId: scope.assistantTurnId,
            runId: current.runId, sink: current.transcriptSink, isCurrent: current.isControlledRunCurrent, onEvent: notify,
          } });
          if (response.status !== "sent") throw Error("MEMORY_CONTEXT_SEND_UNKNOWN");
          return response.result as AgentLoopResult;
        } catch (failure) {
          if (failure instanceof Error && failure.message === "MEMORY_CONTEXT_SETTLEMENT_UNKNOWN") return {
            reply: "", toolResults: [], completionReason: "no_tool", terminal: { status: "runtime_error", reason: "MEMORY_CONTEXT_SETTLEMENT_UNKNOWN", externalEffectsMayContinue: false },
          };
          throw failure;
        }
      };
    }
    return { options: next, latestUserText: built.latestUserText };
  }, { prepareTranscript });

  return {
    runSContext,
    buildOptions,
    onRunFinished: async (result, query, context) => {
      const controlled = context.source === "desktop" && context.mode === "chat" && rawDeps.sContext?.enabled === true
        && rawDeps.sContext.isControlledSession?.(context.conversationId) === true;
      const effects = controlled ? { sticker: null } : await onAgentRunFinished(result, query, finishDependencies(context.modelProfileId), context.channel as ChannelId | undefined, context.conversationId);
      const status = result.terminal?.status;
      if (status !== undefined && status !== "success") return effects;
      const event: PluginTurnCompletedEvent = { source: context.source, mode: context.mode, conversationId: context.conversationId,
        ...(context.channel ? { channel: context.channel } : {}), ...(context.runId ? { runId: context.runId } : {}) };
      void rawDeps.publishPluginHostEvent("turn:completed", event).catch((failure) => { console.warn("[plugins] 发布对话轮次完成事件失败", failure); });
      return effects;
    },
    buildSchedulerOptions: async (task) => {
      const saved = rawDeps.loadModelSettings();
      const modelProfile = getDefaultModelProfile(saved);
      if (rawDeps.defaultMemory && !modelProfile) throw Error("MEMORY_RUN_PROFILE_DENIED");
      const configuration = resolveModelSettingsProfile(saved, modelProfile?.id);
      const profile = rawDeps.loadUserProfile();
      const general = rawDeps.loadGeneralSettings();
      const mode = task.mode ?? "work";
      const history = [{ role: "user" as const, content: task.prompt }];
      const skills = mode === "chat" ? [] : rawDeps.skillRegistry.getEnabledForMode(mode, general.skillModeOverrides);
      const prefix = [buildModePrompt(mode), buildEnvironmentContext({ provider: configuration.provider, model: configuration.model, multimodal: configuration.multimodal }, profile),
        buildSkillCatalog(skills), await (rawDeps.defaultMemory ? buildWorldbookContext : buildAlwaysOnContext)(task.prompt, history),
        await rawDeps.buildPluginPromptContext({ source: "scheduler", mode, userText: task.prompt })].join("\n\n---\n\n");
      return {
        ...(modelProfile ? { modelProfileId: modelProfile.id } : {}), ...(background ? { backgroundMemory: background } : {}),
        settings: { provider: configuration.provider, baseUrl: configuration.baseUrl, model: configuration.model, apiKey: configuration.apiKey,
          explicitTransport: configuration.explicitTransport, reasoning: configuration.reasoning, reasoningLevels: configuration.reasoningLevels, contextWindowTokens: configuration.contextWindowTokens },
        messages: [{ role: "system" as const, content: prefix }, ...history], timeoutMs: 0, onToolFinished: toolFinished,
      };
    },
  };
}
