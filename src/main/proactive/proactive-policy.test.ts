import { describe, it, expect } from "vitest";
import * as gates from "./proactive-policy";
import type { ProactiveCandidate, ProactiveRuntimeSnapshot, ProactiveState } from "./proactive-types";

const clock = Date.UTC(2026, 9, 8, 5, 17);
const proposal: ProactiveCandidate = { sceneId: "desk_pause", score: 92, sceneCooldownMs: 7_200_000 };
const returning: ProactiveCandidate = { sceneId: "back_from_away", score: 75, sceneCooldownMs: 14_400_000 };
const environment: ProactiveRuntimeSnapshot = {
  now: clock, localHour: 13, localMinute: 17, idleSec: 4,
  enabled: true, screenLocked: false, generationBusy: false, conversationBusy: false,
};
const verdict = (state: ProactiveState, change: Partial<ProactiveRuntimeSnapshot> = {}, item = proposal) =>
  gates.canStartProactiveGeneration({ ...environment, ...change }, state, item);
const accepted = { reason: "allowed", allowed: true };
const denied = (reason: string) => ({ reason, allowed: false });

describe("proactive state transitions", () => {
  it("allocates independent empty histories and neutral counters", () => {
    const first = gates.createDefaultProactiveState();
    expect(first).toEqual({ proactiveEpoch: 0, unansweredCount: 0, lastProactiveAt: null,
      lastProactiveScene: null, lastNormalConversationEndedAt: null, globalDesire: 0, affinity: {}, lastFiredAt: {} });
    const second = gates.createDefaultProactiveState();
    expect(first.affinity).not.toBe(second.affinity);
    expect(first.lastFiredAt).not.toBe(second.lastFiredAt);
  });

  it.each([1, 2] as const)("user input clears %i unanswered messages while retaining learned affinity and cooldowns", (unansweredCount) => {
    const stored = gates.createDefaultProactiveState();
    Object.assign(stored, { proactiveEpoch: 7, unansweredCount, globalDesire: 63,
      affinity: { weather_rain: 1.4 }, lastFiredAt: { desk_pause: clock - 50 } });
    const original = structuredClone(stored);
    gates.markUserActivity(stored);
    expect(stored).toEqual({ ...original, unansweredCount: 0, proactiveEpoch: 8 });
  });

  it("conversation lifecycle advances epochs and starts a quiet interval at the supplied instant", () => {
    const stored = gates.createDefaultProactiveState();
    stored.globalDesire = 73;
    gates.markNormalConversationStarted(stored);
    expect(stored.proactiveEpoch).toEqual(1);
    gates.markNormalConversationEnded(stored, clock);
    expect(stored).toMatchObject({ globalDesire: 0, lastNormalConversationEndedAt: clock, proactiveEpoch: 2 });
    expect(verdict(stored)).toEqual(denied("normal_quiet_period"));
  });

  it("records delivery metadata and saturates the unanswered counter at two", () => {
    const stored = gates.createDefaultProactiveState();
    stored.globalDesire = 41;
    for (const count of [1, 2, 2]) {
      gates.markProactiveCommitted(stored, proposal, clock);
      expect(stored).toMatchObject({ globalDesire: 0, unansweredCount: count, lastProactiveAt: clock,
        lastProactiveScene: proposal.sceneId, lastFiredAt: { [proposal.sceneId]: clock } });
    }
  });
});

describe("admission and commit decisions", () => {
  it.each([
    ["enabled", false, "disabled"], ["screenLocked", true, "screen_locked"],
    ["conversationBusy", true, "conversation_busy"], ["generationBusy", true, "generation_busy"],
  ] as const)("rejects the runtime condition %s", (field, value, reason) => {
    expect(verdict(gates.createDefaultProactiveState(), { [field]: value })).toEqual(denied(reason));
  });

  it("gives disabled state priority over every other runtime blocker", () => {
    expect(verdict(gates.createDefaultProactiveState(), { enabled: false, screenLocked: true,
      conversationBusy: true, generationBusy: true })).toEqual(denied("disabled"));
  });

  it.each([
    [21, 59, true], [22, 0, false], [23, 59, false], [0, 0, false], [7, 59, false], [8, 0, true],
  ] as const)("evaluates an idle wall clock at %i:%i", (localHour, localMinute, allowed) => {
    expect(verdict(gates.createDefaultProactiveState(), { localHour, localMinute, idleSec: 3600 }))
      .toEqual(allowed ? accepted : denied("night_inactive"));
  });

  it.each([7, 23])("permits recent activity at hour %i until the sixtieth idle second", (localHour) => {
    const stored = gates.createDefaultProactiveState();
    expect(verdict(stored, { localHour, localMinute: 30, idleSec: 59 })).toEqual(accepted);
    expect(verdict(stored, { localHour, localMinute: 30, idleSec: 60 })).toEqual(denied("night_inactive"));
  });

  it("opens each cooldown exactly at its duration, independently of desire", () => {
    expect([gates.NORMAL_QUIET_MS, gates.GLOBAL_PROACTIVE_INTERVAL_MS, gates.FOLLOWUP_INTERVAL_MS])
      .toEqual([1_800_000, 7_200_000, 43_200_000]);
    const stored = gates.createDefaultProactiveState();
    stored.lastNormalConversationEndedAt = clock - gates.NORMAL_QUIET_MS + 1;
    expect(verdict(stored)).toEqual(denied("normal_quiet_period"));
    stored.lastNormalConversationEndedAt -= 1;
    expect(verdict(stored)).toEqual(accepted);
    stored.lastProactiveAt = clock - gates.GLOBAL_PROACTIVE_INTERVAL_MS + 1;
    expect(verdict(stored)).toEqual(denied("global_cooldown"));
    stored.lastProactiveAt -= 1;
    expect(verdict(stored)).toEqual(accepted);
    stored.globalDesire = 100;
    stored.lastFiredAt[proposal.sceneId] = clock - proposal.sceneCooldownMs + 1;
    expect(verdict(stored)).toEqual(denied("scene_cooldown"));
    stored.lastFiredAt[proposal.sceneId] -= 1;
    expect(verdict(stored)).toEqual(accepted);
  });

  it("opens the final return opportunity at exactly twelve hours, including after a previous return", () => {
    const stored = gates.createDefaultProactiveState();
    Object.assign(stored, { unansweredCount: 1, lastProactiveAt: clock - 43_200_000 + 1,
      lastProactiveScene: returning.sceneId, lastFiredAt: { [returning.sceneId]: clock - 43_200_000 + 1 } });
    expect(verdict(stored, {}, returning)).toEqual(denied("followup_cooldown"));
    stored.lastProactiveAt! -= 1;
    expect(verdict(stored, {}, returning)).toEqual(accepted);
  });

  it("requires at least 75 points for the last return and refuses a third unanswered message", () => {
    expect(gates.FOLLOWUP_MIN_SCORE).toBe(75);
    const stored = gates.createDefaultProactiveState();
    Object.assign(stored, { unansweredCount: 1, lastProactiveAt: clock - 43_200_000,
      lastProactiveScene: "work_break" });
    expect(verdict(stored, {}, { ...returning, score: 74 })).toEqual(denied("followup_score_too_low"));
    expect(verdict(stored, {}, returning)).toEqual(accepted);
    stored.unansweredCount = 2;
    expect(verdict(stored, {}, { ...returning, score: 100 })).toEqual(denied("unanswered_limit"));
  });

  it.each(["work_break", "morning_greeting", "evening_checkin", "weather_rain"])(
    "refuses %s as a followup even with a perfect score and a different previous scene", (sceneId) => {
      const stored = gates.createDefaultProactiveState();
      Object.assign(stored, { unansweredCount: 1, lastProactiveAt: clock - 43_200_000,
        lastProactiveScene: "back_from_away" });
      expect(verdict(stored, {}, { ...returning, sceneId, score: 100 })).toEqual(denied("followup_requires_return"));
    },
  );

  it("retains the four hour return cooldown after model silence during the followup window", () => {
    const stored = gates.createDefaultProactiveState();
    Object.assign(stored, { unansweredCount: 1, lastProactiveAt: clock - 43_200_000,
      lastFiredAt: { back_from_away: clock - 14_400_000 + 1 } });
    expect(verdict(stored, {}, returning)).toEqual(denied("scene_cooldown"));
    stored.lastFiredAt.back_from_away! -= 1;
    expect(verdict(stored, {}, returning)).toEqual(accepted);
  });

  it("rejects an outdated generation before running the ordinary admission gates", () => {
    const stored = gates.createDefaultProactiveState();
    stored.proactiveEpoch = 9;
    expect(gates.canCommitProactiveMessage(environment, stored, proposal, 8)).toEqual(denied("stale_epoch"));
    expect(gates.canCommitProactiveMessage(environment, stored, proposal, 9)).toEqual(accepted);
    expect(gates.canCommitProactiveMessage({ ...environment, screenLocked: true }, stored, proposal, 9))
      .toEqual(denied("screen_locked"));
  });
});
