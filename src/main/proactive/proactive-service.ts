import type { ProactiveCandidate, ProactiveRuntimeSnapshot, ProactiveState } from "./proactive-types";
import type { ProactiveModelResult } from "./proactive-model";
import type { ChatMessage } from "../orchestrator/vendors/types";
import * as policy from "./proactive-policy";

const {
  canCommitProactiveMessage,
  canStartProactiveGeneration,
  markNormalConversationEnded,
  markNormalConversationStarted,
  markProactiveCommitted,
  markUserActivity,
} = policy;

export type ProactiveFallback = { payload?: unknown; text: string };

export type ProactiveCommitInput = {
  source: "model" | "fallback";
  text: string;
  candidate: ProactiveCandidate;
  generationEpoch: number;
  fallbackPayload?: unknown;
  /** 生成期间的取消信号，同样约束每一道投递边界。 */
  signal: AbortSignal;
};

export type ProactiveCommitResult =
  | { kind: "cancelled"; reason: string; deliveryCommitted?: true }
  | { kind: "committed" };

export type ProactiveChatServiceDeps = {
  log?: (event: string, detail?: unknown) => void;
  canStartDelivery?: () => boolean;
  getSnapshot: () => ProactiveRuntimeSnapshot;
  loadState: () => ProactiveState;
  saveState: (state: ProactiveState) => void;
  getFallback: (candidate: ProactiveCandidate) => Promise<ProactiveFallback | null>;
  runModel: (messages: ChatMessage[], signal: AbortSignal) => Promise<ProactiveModelResult>;
  commitMessage: (input: ProactiveCommitInput) => Promise<ProactiveCommitResult>;
  buildMessages: (
    candidate: ProactiveCandidate,
    state: ProactiveState,
    signal: AbortSignal,
  ) => Promise<ChatMessage[]>;
};

export type ProactiveChatService = {
  close(): Promise<void>;
  isGenerating(): boolean;
  invalidate(): void;
  normalConversationEnded(now?: number): void;
  normalConversationStarted(): void;
  invalidateForUserMessage(): void;
  evaluateCandidate(candidate: ProactiveCandidate): Promise<void>;
};

type ChosenText = {
  fallbackPayload: unknown;
  source: "model" | "fallback";
  text: string;
};

/** 只记录真实发生过的冷却时间，不推进未回复计数，也不伪装成完整主动消息。 */
function stampCooldownOnly(state: ProactiveState, candidate: ProactiveCandidate, at: number): void {
  state.lastProactiveAt = at;
  state.lastProactiveScene = candidate.sceneId;
  state.lastFiredAt[candidate.sceneId] = at;
  state.globalDesire = 0;
}

export function createProactiveChatService(deps: ProactiveChatServiceDeps): ProactiveChatService {
  let generating = false;
  let closed = false;
  let liveController: AbortController | undefined;
  let drain: Promise<void> | undefined;

  const note = (event: string, detail?: unknown): void => deps.log?.(event, detail);
  const cancelLive = (): void => liveController?.abort(Error("MEMORY_CONTEXT_CANCELLED"));
  const mutateStored = (mutate: (state: ProactiveState) => void): void => {
    const state = deps.loadState();
    mutate(state);
    deps.saveState(state);
  };

  /** 模型明确选择沉默：只在 epoch 未变时记录，避免覆盖用户的新活动。 */
  function recordSilence(candidate: ProactiveCandidate, epoch: number): void {
    const state = deps.loadState();
    if (state.proactiveEpoch === epoch) {
      state.globalDesire = 0;
      state.lastFiredAt[candidate.sceneId] = deps.getSnapshot().now;
      deps.saveState(state);
    }
    note("model_silent", { scene: candidate.sceneId });
  }

  async function chooseText(
    candidate: ProactiveCandidate,
    outcome: Exclude<ProactiveModelResult, { kind: "silent" }>,
  ): Promise<ChosenText | null> {
    if (outcome.kind === "send") {
      return { text: outcome.text, source: "model", fallbackPayload: undefined };
    }
    // 仅技术失败或输出无效时才允许使用预设；epoch 失效已在调用前拦截。
    const fallback = await deps.getFallback(candidate);
    if (!fallback?.text.trim()) {
      note("fallback_unavailable", { scene: candidate.sceneId, result: outcome.kind });
      return null;
    }
    return { text: fallback.text.trim(), source: "fallback", fallbackPayload: fallback.payload };
  }

  async function produce(
    candidate: ProactiveCandidate,
    startState: ProactiveState,
    epoch: number,
    ctl: AbortController,
  ): Promise<void> {
    const messages = await deps.buildMessages(candidate, startState, ctl.signal);
    if (ctl.signal.aborted) return;
    const outcome = await deps.runModel(messages, ctl.signal);
    if (ctl.signal.aborted) return;
    if (deps.loadState().proactiveEpoch !== epoch) {
      note("generation_discarded", { scene: candidate.sceneId, reason: "stale_epoch" });
      return;
    }
    if (outcome.kind === "silent") {
      recordSilence(candidate, epoch);
      return;
    }

    const chosen = await chooseText(candidate, outcome);
    if (chosen === null) return;
    const { text, source, fallbackPayload } = chosen;

    if (closed || ctl.signal.aborted) return;
    const viewState = deps.loadState();
    const viewSnapshot = deps.getSnapshot();
    const verdict = canCommitProactiveMessage(viewSnapshot, viewState, candidate, epoch);
    if (!verdict.allowed) {
      note("commit_blocked", { scene: candidate.sceneId, reason: verdict.reason, source });
      return;
    }

    const delivered = await deps.commitMessage({
      candidate,
      text,
      source,
      fallbackPayload,
      generationEpoch: epoch,
      signal: ctl.signal,
    });
    if (closed || ctl.signal.aborted || delivered.kind === "cancelled") {
      if (delivered.kind === "committed" || delivered.deliveryCommitted) {
        const state = deps.loadState();
        stampCooldownOnly(state, candidate, viewSnapshot.now);
        deps.saveState(state);
      }
      const reason = delivered.kind === "cancelled"
        ? delivered.reason
        : (closed ? "closed" : "generation_cancelled");
      note("commit_cancelled", { scene: candidate.sceneId, reason, source });
      return;
    }

    const finalState = deps.loadState();
    if (finalState.proactiveEpoch === epoch) {
      markProactiveCommitted(finalState, candidate, viewSnapshot.now);
    } else {
      stampCooldownOnly(finalState, candidate, viewSnapshot.now);
    }
    deps.saveState(finalState);
    note("message_committed", { scene: candidate.sceneId, source });
  }

  return {
    async evaluateCandidate(candidate): Promise<void> {
      if (closed) return;
      const startState = deps.loadState();
      const observed = deps.getSnapshot();
      const gate = { ...observed, generationBusy: observed.generationBusy || generating };
      const verdict = canStartProactiveGeneration(gate, startState, candidate);
      if (!verdict.allowed) {
        note("candidate_blocked", { scene: candidate.sceneId, reason: verdict.reason });
        return;
      }
      if (deps.canStartDelivery && !deps.canStartDelivery()) {
        note("candidate_blocked", { scene: candidate.sceneId, reason: "delivery_unavailable" });
        return;
      }

      generating = true;
      const ctl = new AbortController();
      liveController = ctl;
      let release!: () => void;
      drain = new Promise<void>((resolve) => { release = resolve; });
      try {
        await produce(candidate, startState, startState.proactiveEpoch, ctl);
      } finally {
        liveController = undefined;
        drain = undefined;
        release();
        generating = false;
      }
    },

    invalidateForUserMessage(): void {
      cancelLive();
      mutateStored(markUserActivity);
    },

    normalConversationStarted(): void {
      cancelLive();
      mutateStored(markNormalConversationStarted);
    },

    normalConversationEnded(now = Date.now()): void {
      mutateStored((state) => markNormalConversationEnded(state, now));
    },

    invalidate(): void {
      cancelLive();
      mutateStored((state) => { state.proactiveEpoch += 1; });
    },

    async close(): Promise<void> {
      closed = true;
      cancelLive();
      await drain;
    },

    isGenerating(): boolean {
      return generating;
    },
  };
}
