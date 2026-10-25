// 主动聊天的生命周期装配：把 service、trigger、模型调用、投递通道和电源事件接在一起。
// 本模块只负责接线；判定规则在 policy，文本在 prompt，投递路由在 delivery-routing。
import { getCustomEndpointMode, getCustomEndpointPresentation } from "../../shared/custom-endpoint-state";
import { createBackgroundMemoryIngressIssuer, type BackgroundMemoryHost, type BackgroundMemoryPreparedRun } from "../memory-context/background-memory-ingress";
import type { MainMemoryRun } from "../memory-context/main-memory-runtime";
import type { ChatMessage } from "../orchestrator/vendors/types";
import { searchMemory } from "../rag";
import { randomUUID } from "crypto";
import { powerMonitor } from "electron";
import * as chatsStore from "../chats/chats-store";
import { broadcastChatsChanged } from "../chats/chats-ipc";
import { setChannelsConversationLifecycle } from "../channels/init";
import { channelManager } from "../channels/manager";
import { sendProactiveChannelMessage, canStartProactiveChannelDelivery, type ProactiveMobileChannel } from "../channels/proactive-delivery";
import { resolveChatContextTimezone } from "../chat/chat-time-context";
import { buildAlwaysOnContext, buildMemoryInjection, buildWorldbookContext } from "../orchestrator";
import { loadPromptFile } from "../prompts/prompt-loader";
import type { GeneralSettings } from "../settings/general-settings";
import { loadModelSettings, getDefaultModelProfile, resolveModelSettingsProfile } from "../settings/model-settings";
import { loadUserProfile } from "../storage/settings-store";
import { createProactiveChatService } from "./proactive-service";
import type { ProactiveChatService, ProactiveCommitInput, ProactiveCommitResult } from "./proactive-service";
import { routeProactiveDelivery } from "./proactive-delivery-routing";
import { buildProactiveMessages, type ProactiveHistoryTurn } from "./proactive-prompt";
import { getZonedDateParts } from "./proactive-clock";
import { canCommitProactiveMessage } from "./proactive-policy";
import { loadProactiveState, saveProactiveState } from "./proactive-state-store";
import { createProactiveTrigger, type ProactiveTriggerController } from "./proactive-trigger";
import { runProactiveModel, type ProactiveModelResult } from "./proactive-model";
import type { ProactiveCandidate, ProactiveRuntimeSnapshot } from "./proactive-types";

export type ProactiveLifecycleOptions = {
  loadGeneralSettings: () => GeneralSettings;
  memoryHost?: BackgroundMemoryHost;
};

export type ProactiveLifecycle = {
  close(): Promise<void>;
  stopProactiveTrigger: () => void;
  initializeProactiveTrigger: () => void;
  initializeProactiveChatService: () => void;
  getProactiveChatService: () => ProactiveChatService | null;
  proactiveConversationLifecycle: {
    onConversationEnded: () => void;
    onConversationStarted: () => void;
    onUserMessage: () => void;
  };
};

type GenerationTicket = { candidate: ProactiveCandidate; epoch: number; signal: AbortSignal };

const PROACTIVE_CALL_TIMEOUT_MS = 45_000;
const HISTORY_TAKE = 16;
const TOPIC_TAKE = 4;
const PROACTIVE_SESSION_PURPOSE = "proactive-chat";
const PROACTIVE_SESSION_TITLE = "流萤的主动消息";
const MEMORY_ERROR_PATTERN = /^MEMORY_[A-Z0-9_]+$/;

export function createProactiveLifecycle(options: ProactiveLifecycleOptions): ProactiveLifecycle {
  let chatService: ProactiveChatService | null = null;
  let triggerCtl: ProactiveTriggerController | null = null;
  const evaluatedAt = new Map<string, number>();
  let normalBusy = 0;
  let screenLocked = false;
  let closing = false;
  const tickets = new WeakMap<ChatMessage[], GenerationTicket>();
  const liveSources = new Set<object>();
  const issuer = createBackgroundMemoryIngressIssuer({
    entry: "proactive",
    isCurrent: (source) => !closing && liveSources.has(source),
  });

  /** 人格提示由三段拼成：聊天系统、Soul（去掉 Live2D 章节）、语录。 */
  function assemblePersona(): string {
    const pieces: string[] = [];
    const system = loadPromptFile("chat_system.md");
    if (system) pieces.push(system);
    const soulDoc = loadPromptFile("soul.md");
    if (soulDoc) {
      // 主动轮不带工具说明，所以截掉 Soul 中 Live2D 与联网相关的尾部章节。
      pieces.push(soulDoc.split("\n## Live2D 与聊天文字的分工")[0].trim());
    }
    const quotes = loadPromptFile("canon_quotes.md");
    if (quotes) pieces.push(quotes);
    return pieces.join("\n\n---\n\n");
  }

  function trimHistory(turns: Array<{ role: "user" | "model"; content: string; at: number }>): ProactiveHistoryTurn[] {
    return turns
      .filter((turn) => turn.content.trim())
      .slice(-HISTORY_TAKE)
      .map((turn) => ({ role: turn.role, content: turn.content, at: turn.at }));
  }

  function readHistories(): { ordinary: ProactiveHistoryTurn[]; proactive: ProactiveHistoryTurn[] } {
    const firstOrdinary = chatsStore.listSessions().find((meta) => meta.purpose !== PROACTIVE_SESSION_PURPOSE);
    const ordinarySession = firstOrdinary ? chatsStore.getSession(firstOrdinary.id) : null;
    const proactiveSession = chatsStore.getSessionByPurpose(PROACTIVE_SESSION_PURPOSE);
    return {
      ordinary: trimHistory(ordinarySession?.messages ?? []),
      proactive: trimHistory(proactiveSession?.messages ?? []),
    };
  }

  function currentSnapshot(): ProactiveRuntimeSnapshot {
    const nowMs = Date.now();
    let idle = Number.POSITIVE_INFINITY;
    try {
      idle = powerMonitor.getSystemIdleTime();
    } catch {
      // app 尚未 ready 时保持无穷大，等同于没有输入记录。
    }
    const tz = resolveChatContextTimezone(loadUserProfile().timezone);
    const wall = getZonedDateParts(new Date(nowMs), tz);
    return {
      now: nowMs,
      localHour: wall.hour,
      localMinute: wall.minute,
      idleSec: idle,
      enabled: options.loadGeneralSettings().proactiveChatMode === "on",
      conversationBusy: normalBusy > 0,
      generationBusy: false,
      screenLocked,
    };
  }

  async function assembleMessages(candidate: ProactiveCandidate): Promise<ChatMessage[]> {
    const host = options.memoryHost;
    const histories = host ? { ordinary: [], proactive: [] } : readHistories();
    const topic = histories.ordinary.slice(-TOPIC_TAKE).map((turn) => turn.content).join("\n");
    const query = `${candidate.sceneId}\n${topic}`.trim();
    const [profileContext, memoryContext] = host
      ? await Promise.all([
        buildWorldbookContext(query, []).catch(() => ""),
        searchMemory(query, "imported_doc", 2)
          .then((docs) => (docs.length ? "【相关文档】\n" + docs.join("\n") : ""))
          .catch(() => ""),
      ])
      : await Promise.all([
        buildAlwaysOnContext(query, histories.ordinary.map((turn) => ({ role: turn.role, content: turn.content })))
          .catch(() => ""),
        buildMemoryInjection(query).catch(() => ""),
      ]);
    const persisted = loadProactiveState();
    const snap = currentSnapshot();
    const timezone = resolveChatContextTimezone(loadUserProfile().timezone);
    return buildProactiveMessages({
      basePersona: assemblePersona(),
      sceneId: candidate.sceneId,
      proactiveHistory: histories.proactive,
      ordinaryHistory: histories.ordinary,
      relevantMemory: memoryContext,
      userProfile: profileContext,
      localNow: new Date(snap.now),
      idleSec: snap.idleSec,
      unansweredCount: persisted.unansweredCount,
      timezone,
    });
  }

  function bumpBusy(delta: 1 | -1): void {
    normalBusy = Math.max(0, normalBusy + delta);
  }

  const proactiveConversationLifecycle = {
    onUserMessage: () => chatService?.invalidateForUserMessage(),
    onConversationStarted: () => {
      bumpBusy(1);
      chatService?.normalConversationStarted();
    },
    onConversationEnded: () => {
      bumpBusy(-1);
      if (normalBusy === 0) chatService?.normalConversationEnded();
    },
  };

  function commitVerdict(candidate: ProactiveCandidate, epoch: number, signal?: AbortSignal) {
    if (closing || signal?.aborted) return { allowed: false as const, reason: "generation_cancelled" };
    return canCommitProactiveMessage(currentSnapshot(), loadProactiveState(), candidate, epoch);
  }

  async function commitLocal(input: ProactiveCommitInput): Promise<ProactiveCommitResult> {
    const verdict = commitVerdict(input.candidate, input.generationEpoch, input.signal);
    if (!verdict.allowed) return { kind: "cancelled", reason: verdict.reason };

    const session = chatsStore.getOrCreateSessionByPurpose(PROACTIVE_SESSION_PURPOSE, {
      title: PROACTIVE_SESSION_TITLE,
      identityId: null,
    });
    const written = chatsStore.appendMessage(session.id, {
      id: randomUUID(),
      role: "model",
      content: input.text,
      at: Date.now(),
    });
    if (!written) throw new Error("主动聊天会话写入失败");
    broadcastChatsChanged();
    return { kind: "committed" };
  }

  async function commitViaChannel(input: ProactiveCommitInput, channel: ProactiveMobileChannel): Promise<ProactiveCommitResult> {
    const outcome = await sendProactiveChannelMessage({
      manager: channelManager,
      text: input.text,
      channel,
      canContinue: () => {
        if (options.loadGeneralSettings().proactiveDeliveryTarget !== channel) return false;
        return commitVerdict(input.candidate, input.generationEpoch, input.signal).allowed;
      },
    });
    if (outcome.kind === "committed") return { kind: "committed" };
    return { kind: "cancelled", reason: outcome.reason };
  }

  async function commitChosen(input: ProactiveCommitInput): Promise<ProactiveCommitResult> {
    const verdict = commitVerdict(input.candidate, input.generationEpoch, input.signal);
    if (!verdict.allowed) return { kind: "cancelled", reason: verdict.reason };

    const target = options.loadGeneralSettings().proactiveDeliveryTarget;
    const routed = await routeProactiveDelivery(target, {
      commitLocal: () => commitLocal(input),
      commitChannel: (channel) => commitViaChannel(input, channel),
    });

    // 已经开始的渠道发送会由渠道日志负责收尾；被取消的生成不能再记为一次完整提交。
    if (closing || input.signal.aborted) {
      const carried = routed.kind === "committed" ? { deliveryCommitted: true as const } : {};
      return { kind: "cancelled", reason: "generation_cancelled", ...carried };
    }
    return routed;
  }

  async function invokeModel(messages: ChatMessage[], signal: AbortSignal): Promise<ProactiveModelResult> {
    const saved = loadModelSettings();
    const defaultProfile = getDefaultModelProfile(saved);
    const resolved = resolveModelSettingsProfile(saved);
    const customMode = getCustomEndpointMode(resolved.provider);
    const keyOptional = customMode !== null && getCustomEndpointPresentation(customMode).apiKeyOptional;
    if (!keyOptional && !resolved.apiKey?.trim()) return { kind: "error", reason: "missing_api_key" };

    const vendorConfig = {
      provider: resolved.provider,
      baseUrl: resolved.baseUrl,
      model: resolved.model,
      apiKey: resolved.apiKey,
      explicitTransport: resolved.explicitTransport,
      reasoning: resolved.reasoning,
    };

    const host = options.memoryHost;
    if (!host) {
      return runProactiveModel({ signal, settings: vendorConfig, messages, timeoutMs: PROACTIVE_CALL_TIMEOUT_MS });
    }

    if (!defaultProfile) return { kind: "error", reason: "MEMORY_RUN_PROFILE_DENIED" };
    const ticket = tickets.get(messages);
    const source = {};
    const stillCurrent = ticket !== undefined
      && ticket.signal === signal
      && ticket.epoch === loadProactiveState().proactiveEpoch
      && !closing
      && !signal.aborted;
    if (!stillCurrent) return { kind: "error", reason: "MEMORY_CONTEXT_CANCELLED" };

    const runId = randomUUID();
    const instructionText = messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n");
    liveSources.add(source);
    let prepared: BackgroundMemoryPreparedRun | undefined;
    let memoryRun: MainMemoryRun | undefined;
    try {
      const ingress = issuer.capture({
        source,
        sessionId: "proactive-memory-v1",
        sourceKey: "proactive-trigger-v1",
        instructionText,
        signal,
      });
      prepared = await host.prepareBackgroundRun({
        ingress,
        modelProfileId: defaultProfile.id,
        runId,
        userTurnId: `${runId}-instruction`,
        assistantTurnId: `${runId}-assistant`,
        instructionText,
        signal,
      });
      memoryRun = await prepared.openMemoryRun({
        settings: { ...vendorConfig, contextWindowTokens: resolved.contextWindowTokens },
        messages,
        runId,
        conversationId: prepared.sessionId,
        signal: prepared.signal,
        transcriptSink: prepared.transcriptSink,
        toolSystemContent: "",
        soulSystemBaseContent: "",
        timeoutMs: PROACTIVE_CALL_TIMEOUT_MS,
      });
      return await runProactiveModel({
        settings: vendorConfig,
        messages,
        timeoutMs: PROACTIVE_CALL_TIMEOUT_MS,
        signal: prepared.signal,
        memoryRun,
        transcriptSink: prepared.transcriptSink,
      });
    } catch (error) {
      const isMemoryCode = error instanceof Error && MEMORY_ERROR_PATTERN.test(error.message);
      return { kind: "error", reason: isMemoryCode ? (error as Error).message : "memory_runtime_error" };
    } finally {
      try {
        await memoryRun?.close();
      } finally {
        await prepared?.close();
        liveSources.delete(source);
      }
    }
  }

  function initializeProactiveChatService(): void {
    chatService = createProactiveChatService({
      loadState: loadProactiveState,
      saveState: (state) => saveProactiveState(state),
      getSnapshot: currentSnapshot,
      buildMessages: async (candidate, state, signal) => {
        const epoch = state.proactiveEpoch;
        const messages = await assembleMessages(candidate);
        tickets.set(messages, { candidate, epoch, signal });
        return messages;
      },
      runModel: (messages, signal) => invokeModel(messages, signal),
      // 兜底文案已下线，模型失败时 service 直接取消。
      getFallback: () => Promise.resolve(null),
      canStartDelivery: () => {
        const target = options.loadGeneralSettings().proactiveDeliveryTarget;
        return target === "local" || canStartProactiveChannelDelivery(target, channelManager);
      },
      commitMessage: commitChosen,
      log: (event, detail) => console.log(`[Proactive] ${event}`, detail ?? ""),
    });

    setChannelsConversationLifecycle(proactiveConversationLifecycle);

    powerMonitor.on("lock-screen", () => {
      screenLocked = true;
      chatService?.invalidate();
    });
    powerMonitor.on("unlock-screen", () => { screenLocked = false; });
    powerMonitor.on("suspend", () => {
      screenLocked = true;
      chatService?.invalidate();
    });
    powerMonitor.on("resume", () => { screenLocked = false; });
  }

  function initializeProactiveTrigger(): void {
    if (triggerCtl) return;
    if (!chatService) {
      console.warn("[Proactive] trigger skipped: service not initialized");
      return;
    }
    const service = chatService;
    triggerCtl = createProactiveTrigger({
      evaluateCandidate: (candidate) => service.evaluateCandidate(candidate),
      getRuntimeSnapshot: currentSnapshot,
      getProactiveState: loadProactiveState,
      getTimezone: () => resolveChatContextTimezone(loadUserProfile().timezone),
      // 天气上下文尚未接入，因此这里不传 getWeatherContext。
      getLastEvaluatedAtByScene: () => new Map(evaluatedAt),
      setLastEvaluatedAtByScene: (next) => {
        evaluatedAt.clear();
        next.forEach((value, key) => evaluatedAt.set(key, value));
      },
    });
    triggerCtl.start();
  }

  function stopProactiveTrigger(): void {
    triggerCtl?.stop();
    triggerCtl = null;
  }

  return {
    proactiveConversationLifecycle,
    getProactiveChatService: () => chatService,
    initializeProactiveTrigger,
    initializeProactiveChatService,
    stopProactiveTrigger,
    async close(): Promise<void> {
      closing = true;
      stopProactiveTrigger();
      await chatService?.close();
    },
  };
}
