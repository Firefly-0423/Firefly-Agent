import { describe, it, expect, vi } from "vitest";
import { createProactiveChatService, type ProactiveChatServiceDeps, type ProactiveCommitResult } from "./proactive-service";
import { createDefaultProactiveState, FOLLOWUP_INTERVAL_MS } from "./proactive-policy";
import type { ProactiveModelResult } from "./proactive-model";
import type { ProactiveCandidate, ProactiveRuntimeSnapshot } from "./proactive-types";

const instant = Date.UTC(2026, 9, 9, 7, 36);
const invitation: ProactiveCandidate = { score: 96, sceneId: "afternoon_pause", sceneCooldownMs: 0 };
function latch<T>() {
  let complete!: (value: T) => void;
  const value = new Promise<T>((resolve) => { complete = resolve; });
  return { complete, value };
}
function createRig(replacements: Partial<ProactiveChatServiceDeps> = {}) {
  const stored = createDefaultProactiveState();
  const runtime: ProactiveRuntimeSnapshot = { now: instant, localHour: 15, localMinute: 36,
    idleSec: 2, enabled: true, screenLocked: false, generationBusy: false, conversationBusy: false };
  const hooks = {
    getSnapshot: () => ({ ...runtime }), loadState: () => stored,
    saveState: vi.fn<ProactiveChatServiceDeps["saveState"]>(),
    buildMessages: vi.fn<ProactiveChatServiceDeps["buildMessages"]>(async () => [{ role: "user", content: "Decide on a pause" }]),
    runModel: vi.fn<ProactiveChatServiceDeps["runModel"]>(async () => ({ kind: "send", text: "Look away from the screen for a moment?" })),
    getFallback: vi.fn<ProactiveChatServiceDeps["getFallback"]>(async () => ({ text: "  A small break could help.  ", payload: { clip: "pause-chime" } })),
    commitMessage: vi.fn<ProactiveChatServiceDeps["commitMessage"]>(async () => ({ kind: "committed" })),
    log: vi.fn<NonNullable<ProactiveChatServiceDeps["log"]>>(),
  };
  return { stored, runtime, hooks, api: createProactiveChatService({ ...hooks, ...replacements }) };
}

describe("delivery outcomes and persisted state", () => {
  it("passes the generated message, epoch and shared cancellation signal through the delivery boundary", async () => {
    const rig = createRig();
    await rig.api.evaluateCandidate(invitation);
    expect(rig.hooks.buildMessages).toHaveBeenCalledTimes(1);
    expect(rig.hooks.buildMessages).toHaveBeenCalledWith(invitation, expect.objectContaining({ proactiveEpoch: 0 }), expect.any(AbortSignal));
    const signal = rig.hooks.buildMessages.mock.calls[0][2];
    expect(rig.hooks.runModel).toHaveBeenCalledExactlyOnceWith([{ role: "user", content: "Decide on a pause" }], signal);
    expect(rig.hooks.commitMessage).toHaveBeenCalledExactlyOnceWith({ text: "Look away from the screen for a moment?",
      candidate: invitation, source: "model", generationEpoch: 0, fallbackPayload: undefined, signal });
    expect(rig.stored).toMatchObject({ unansweredCount: 1, lastProactiveAt: instant,
      lastProactiveScene: invitation.sceneId, lastFiredAt: { [invitation.sceneId]: instant } });
    expect(rig.hooks.getFallback.mock.calls).toEqual([]);
    expect(rig.api.isGenerating()).toBe(false);
  });

  it("records explicit silence without a delivery or preset lookup", async () => {
    const rig = createRig({ runModel: async () => ({ kind: "silent" }) });
    rig.stored.globalDesire = 67;
    await rig.api.evaluateCandidate(invitation);
    expect(rig.hooks.commitMessage.mock.calls).toEqual([]);
    expect(rig.hooks.getFallback.mock.calls).toEqual([]);
    expect(rig.stored).toMatchObject({ globalDesire: 0, unansweredCount: 0, lastProactiveAt: null,
      lastFiredAt: { [invitation.sceneId]: instant } });
  });

  it.each([
    { kind: "invalid", reason: "invalid_json" }, { kind: "error", reason: "timeout" },
  ] as const)("selects a trimmed preset after a $kind result", async (outcome) => {
    const rig = createRig({ runModel: async () => outcome });
    await rig.api.evaluateCandidate(invitation);
    expect(rig.hooks.getFallback).toHaveBeenCalledExactlyOnceWith(invitation);
    expect(rig.hooks.commitMessage).toHaveBeenCalledExactlyOnceWith({ candidate: invitation, generationEpoch: 0,
      signal: expect.any(AbortSignal), text: "A small break could help.", source: "fallback", fallbackPayload: { clip: "pause-chime" } });
  });

  it.each([null, { text: " \t" }])("stays silent when the fallback is unusable: %j", async (preset) => {
    const rig = createRig({ runModel: async () => ({ kind: "error", reason: "network_error" }), getFallback: async () => preset });
    await rig.api.evaluateCandidate(invitation);
    expect(rig.hooks.commitMessage.mock.calls).toEqual([]);
    expect(rig.stored.unansweredCount).toBe(0);
  });

  it("preserves all cooldowns and unanswered state when the channel rejects delivery", async () => {
    const rig = createRig({ commitMessage: async () => ({ reason: "channel_offline", kind: "cancelled" }) });
    await rig.api.evaluateCandidate(invitation);
    expect(rig.stored.lastProactiveAt).toBeNull();
    expect(rig.stored.unansweredCount).toEqual(0);
    expect(rig.stored.lastFiredAt[invitation.sceneId]).toBeUndefined();
    expect(rig.hooks.log).toHaveBeenCalledExactlyOnceWith("commit_cancelled", {
      reason: "channel_offline", scene: invitation.sceneId, source: "model",
    });
  });

  it("allows one final return, rejects a third delivery, and resumes after a user message", async () => {
    const rig = createRig();
    await rig.api.evaluateCandidate(invitation);
    expect(rig.stored.unansweredCount).toEqual(1);
    rig.runtime.now += FOLLOWUP_INTERVAL_MS;
    const returning = { sceneId: "back_from_away", score: 75, sceneCooldownMs: 14_400_000 };
    await rig.api.evaluateCandidate(returning);
    expect(rig.stored.unansweredCount).toEqual(2);
    rig.runtime.now += FOLLOWUP_INTERVAL_MS;
    await rig.api.evaluateCandidate({ ...returning, score: 100 });
    expect(rig.hooks.commitMessage.mock.calls).toHaveLength(2);
    expect(rig.hooks.runModel.mock.calls).toHaveLength(2);
    expect(rig.hooks.log).toHaveBeenCalledWith("candidate_blocked", { scene: "back_from_away", reason: "unanswered_limit" });
    rig.api.invalidateForUserMessage();
    expect(rig.stored.unansweredCount).toBe(0);
    expect(rig.hooks.saveState).toHaveBeenLastCalledWith(rig.stored);
    await rig.api.evaluateCandidate(invitation);
    expect(rig.stored.unansweredCount).toBe(1);
    expect(rig.hooks.commitMessage).toHaveBeenCalledTimes(3);
  });

  it.each(["work_break", "morning_greeting", "evening_checkin"])("logs the return-only reason for a %s followup", async (sceneId) => {
    const rig = createRig();
    Object.assign(rig.stored, { unansweredCount: 1, lastProactiveAt: instant - FOLLOWUP_INTERVAL_MS,
      lastProactiveScene: "back_from_away" });
    await rig.api.evaluateCandidate({ ...invitation, sceneId, score: 100 });
    expect(rig.hooks.log).toHaveBeenCalledExactlyOnceWith("candidate_blocked", { scene: sceneId, reason: "followup_requires_return" });
    expect(rig.hooks.buildMessages).not.toHaveBeenCalled();
    expect(rig.hooks.runModel).not.toHaveBeenCalled();
    expect(rig.hooks.commitMessage).not.toHaveBeenCalled();
    expect(rig.stored.unansweredCount).toBe(1);
  });
});

describe("admission and lifecycle", () => {
  it("checks destination availability before generating anything", async () => {
    const rig = createRig({ canStartDelivery: () => false });
    await rig.api.evaluateCandidate(invitation);
    expect(rig.hooks.runModel.mock.calls).toEqual([]);
    expect(rig.hooks.commitMessage.mock.calls).toEqual([]);
    expect(rig.hooks.buildMessages.mock.calls).toEqual([]);
  });

  it("does not start even an error-producing model during a normal conversation", async () => {
    const model = vi.fn<ProactiveChatServiceDeps["runModel"]>(async () => ({ kind: "error", reason: "timeout" }));
    const rig = createRig({ runModel: model });
    rig.runtime.conversationBusy = true;
    await rig.api.evaluateCandidate(invitation);
    expect(rig.hooks.commitMessage.mock.calls).toEqual([]);
    expect(model.mock.calls).toEqual([]);
  });

  it("advances the generation epoch on conversation start and end", () => {
    const rig = createRig();
    rig.api.normalConversationStarted();
    rig.api.normalConversationEnded(instant);
    expect(rig.stored.proactiveEpoch).toEqual(2);
    expect(rig.stored.lastNormalConversationEndedAt).toEqual(instant);
  });

  it("rechecks current conversation state after a real model response", async () => {
    const response = latch<ProactiveModelResult>();
    const entered = latch<void>();
    const rig = createRig({ runModel: async () => { entered.complete(); return response.value; } });
    const running = rig.api.evaluateCandidate(invitation);
    await entered.value;
    rig.runtime.conversationBusy = true;
    response.complete({ kind: "send", text: "A delayed suggestion" });
    await running;
    expect(rig.hooks.commitMessage.mock.calls).toEqual([]);
    expect(rig.hooks.log).toHaveBeenCalledWith("commit_blocked", { scene: invitation.sceneId, reason: "conversation_busy", source: "model" });
  });

  it("rechecks policy after waiting for a fallback as well", async () => {
    const preset = latch<{ text: string }>();
    const entered = latch<void>();
    const rig = createRig({ runModel: async () => ({ kind: "invalid", reason: "invalid_json" }),
      getFallback: async () => { entered.complete(); return preset.value; } });
    const running = rig.api.evaluateCandidate(invitation);
    await entered.value;
    rig.runtime.screenLocked = true;
    preset.complete({ text: "A saved reminder" });
    await running;
    expect(rig.hooks.commitMessage.mock.calls).toEqual([]);
  });
});

describe("in-flight cancellation", () => {
  it("aborts on user input, discards the result, and waits for actual settlement before close resolves", async () => {
    const response = latch<ProactiveModelResult>();
    const entered = latch<AbortSignal>();
    const rig = createRig({ runModel: async (_messages, signal) => { entered.complete(signal); return response.value; } });
    const running = rig.api.evaluateCandidate(invitation);
    const signal = await entered.value;
    rig.api.invalidateForUserMessage();
    expect(signal.aborted).toBe(true);
    expect(rig.stored).toMatchObject({ proactiveEpoch: 1, unansweredCount: 0 });
    let drained = false;
    const closing = rig.api.close().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(rig.api.isGenerating()).toBe(true);
    response.complete({ kind: "send", text: "This reply arrived after cancellation" });
    await Promise.all([running, closing]);
    expect(drained).toBe(true);
    expect(rig.api.isGenerating()).toBe(false);
    expect(rig.hooks.commitMessage.mock.calls).toEqual([]);
    expect(rig.stored).toMatchObject({ proactiveEpoch: 1, unansweredCount: 0 });
    await rig.api.evaluateCandidate(invitation);
    expect(rig.hooks.buildMessages.mock.calls).toHaveLength(1);
  });

  it("retains newer user activity while recording that a delayed delivery actually occurred", async () => {
    const receipt = latch<ProactiveCommitResult>();
    const entered = latch<void>();
    const rig = createRig({ commitMessage: async () => { entered.complete(); return receipt.value; } });
    const running = rig.api.evaluateCandidate(invitation);
    await entered.value;
    rig.api.invalidateForUserMessage();
    receipt.complete({ kind: "committed" });
    await running;
    expect(rig.stored).toMatchObject({ proactiveEpoch: 1, unansweredCount: 0, lastProactiveAt: instant,
      lastProactiveScene: invitation.sceneId, lastFiredAt: { [invitation.sceneId]: instant } });
  });
});
