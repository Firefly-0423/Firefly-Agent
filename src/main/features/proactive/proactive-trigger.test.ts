import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createProactiveTrigger, getZonedDateParts, type ProactiveTriggerDependencies } from "./proactive-trigger";
import { createDefaultProactiveState, canStartProactiveGeneration, markProactiveCommitted, FOLLOWUP_MIN_SCORE } from "./proactive-policy";
import type { ProactiveCandidate, ProactiveRuntimeSnapshot } from "./proactive-types";

const minute = 60_000;
const hour = minute * 60;
const evening = Date.UTC(2026, 9, 12, 11);
const midday = Date.UTC(2026, 9, 12, 3);
function scheduler(changes: Partial<ProactiveTriggerDependencies> = {}) {
  const stored = createDefaultProactiveState();
  const runtime: ProactiveRuntimeSnapshot = { now: evening, localHour: 20, localMinute: 0,
    idleSec: 17, enabled: true, screenLocked: false, generationBusy: false, conversationBusy: false };
  let attempted = new Map<string, number>();
  const deliver = vi.fn<ProactiveTriggerDependencies["evaluateCandidate"]>(async () => undefined);
  const controller = createProactiveTrigger({
    getTimezone: () => "Asia/Tokyo", getRuntimeSnapshot: () => ({ ...runtime }), getProactiveState: () => stored,
    getLastEvaluatedAtByScene: () => new Map(attempted),
    setLastEvaluatedAtByScene: (next) => { attempted = new Map(next); }, evaluateCandidate: deliver, ...changes,
  });
  return { stored, runtime, deliver, controller,
    clearBackoff: () => attempted.clear(),
    async observe(now: number, idleSec = 17) {
      Object.assign(runtime, { now, idleSec });
      await controller.evaluateNow("scheduled observation");
    },
  };
}
async function absenceScore(seconds: number, unanswered: 0 | 1 = 0): Promise<number> {
  const rig = scheduler();
  rig.stored.unansweredCount = unanswered;
  await rig.observe(midday, seconds);
  await rig.observe(midday + 75_000);
  expect(rig.deliver.mock.calls).toHaveLength(1);
  const candidate = rig.deliver.mock.calls[0][0];
  expect(candidate).toMatchObject({ sceneId: "back_from_away", sceneCooldownMs: 4 * hour });
  return candidate.score;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("opportunity eligibility and ranking", () => {
  it("does not invent a scene on the first observation outside greeting windows", async () => {
    const rig = scheduler();
    await rig.observe(midday, 0);
    expect(rig.deliver.mock.calls).toEqual([]);
  });

  it("emits the morning scene with its daily cooldown in the configured timezone", async () => {
    const rig = scheduler();
    await rig.observe(Date.UTC(2026, 9, 12, 23, 30), 0);
    expect(rig.deliver.mock.calls).toEqual([[{ sceneId: "morning_greeting", sceneCooldownMs: 23 * hour, score: 77 }]]);
  });

  it("selects one evening scene initially and prioritizes a returning user over the greeting", async () => {
    const rig = scheduler();
    rig.stored.lastNormalConversationEndedAt = evening - 3 * hour;
    await rig.observe(evening);
    expect(rig.deliver.mock.calls).toEqual([[{ sceneId: "evening_checkin", score: 71, sceneCooldownMs: 8 * hour }]]);
    await rig.observe(evening + minute, 1800);
    expect(rig.deliver.mock.calls).toHaveLength(1);
    rig.clearBackoff();
    await rig.observe(evening + 2 * minute, 59);
    expect(rig.deliver.mock.calls.map(([candidate]) => candidate)).toEqual([
      { sceneId: "evening_checkin", score: 71, sceneCooldownMs: 8 * hour },
      { sceneId: "back_from_away", score: 84, sceneCooldownMs: 4 * hour },
    ]);
  });

  it.each([30, 31])("retries an evening evaluation after %i minutes, but not earlier than thirty", async (elapsedMinutes) => {
    const rig = scheduler();
    await rig.observe(evening, 0);
    await rig.observe(evening + minute, 0);
    await rig.observe(evening + 30 * minute - 1, 0);
    expect(rig.deliver.mock.calls).toHaveLength(1);
    await rig.observe(evening + elapsedMinutes * minute, 0);
    expect(rig.deliver.mock.calls).toHaveLength(2);
    expect(rig.deliver.mock.calls.map(([candidate]) => candidate.sceneId)).toEqual(["evening_checkin", "evening_checkin"]);
  });

  it.each([
    { name: "no weather hook", hooks: {} },
    { name: "unavailable weather", hooks: { getWeatherContext: () => null } },
    { name: "empty weather", hooks: { getWeatherContext: () => ({}) } },
  ])("keeps normal greetings working with $name", async ({ hooks }) => {
    const rig = scheduler(hooks);
    await rig.observe(evening, 0);
    expect(rig.deliver.mock.calls).toEqual([[{ sceneId: "evening_checkin", score: 71, sceneCooldownMs: 8 * hour }]]);
    for (const [candidate] of rig.deliver.mock.calls) expect(candidate.sceneId).not.toMatch(/^weather_/);
  });

  it.each([
    { enabled: false }, { conversationBusy: true }, { generationBusy: true }, { screenLocked: true },
  ])("does not evaluate a candidate under runtime blocker %j", async (blocker) => {
    const rig = scheduler();
    Object.assign(rig.runtime, blocker);
    await rig.observe(evening, 0);
    expect(rig.deliver.mock.calls).toEqual([]);
  });
});

describe("return transitions and scoring", () => {
  it.each([
    [1799, 17, false], [1800, 60, false], [1800, 59, true],
  ] as const)("requires an absence of %i seconds followed by %i idle seconds", async (away, idle, eligible) => {
    const rig = scheduler();
    await rig.observe(midday, away);
    expect(rig.deliver.mock.calls).toEqual([]);
    await rig.observe(midday + minute, idle);
    expect(rig.deliver.mock.calls).toEqual(eligible ? [[{ sceneId: "back_from_away", score: 84, sceneCooldownMs: 4 * hour }]] : []);
  });

  it.each([
    [1_800, 84], [2_700, 86], [3_600, 88], [7_200, 92], [14_400, 96], [28_800, 100], [86_400, 100],
  ])("scores a %i second absence as %i points", async (seconds, expected) => {
    expect(await absenceScore(seconds)).toEqual(expected);
  });

  it("increases monotonically across short and long absences", async () => {
    const scores = await Promise.all([30, 40, 55, 60, 90, 180, 360, 720].map((duration) => absenceScore(duration * 60)));
    expect(scores).toEqual([...scores].sort((left, right) => left - right));
    expect(scores.at(-1)).toBeGreaterThan(scores[0]);
  });

  it("keeps a high-urgency return eligible for the final followup after a day away", async () => {
    expect(await absenceScore(86_400, 1)).toBeGreaterThanOrEqual(FOLLOWUP_MIN_SCORE);
  });

  it.each([
    [3_600, 73, false], [5_400, 75, true], [14_400, 81, true], [28_800, 85, true],
  ] as const)("passes a %i second return scored at %i through the real followup policy only when urgent enough", async (away, score, allowed) => {
    const rig = scheduler();
    Object.assign(rig.stored, { unansweredCount: 1, lastProactiveAt: midday - 24 * hour,
      lastProactiveScene: "morning_greeting" });
    await rig.observe(midday, away);
    await rig.observe(midday + minute, 0);
    expect(rig.deliver.mock.calls).toHaveLength(1);
    const candidate = rig.deliver.mock.calls[0][0];
    expect(candidate).toEqual({ sceneId: "back_from_away", score, sceneCooldownMs: 4 * hour });
    expect(canStartProactiveGeneration({ ...rig.runtime, localHour: 12, localMinute: 1 }, rig.stored, candidate))
      .toEqual(allowed ? { allowed: true, reason: "allowed" } : { allowed: false, reason: "followup_score_too_low" });
  });

  it("keeps sampled low-urgency post-silence scenes below the policy followup threshold", async () => {
    const rig = scheduler();
    rig.stored.unansweredCount = 1;
    const timeline = [
      [evening, 0], [evening + 31 * minute, 1800], [evening + 32 * minute, 7],
      [evening + 8 * hour, 0], [evening + 8 * hour + minute, 0],
      [Date.UTC(2026, 9, 12, 23, 45), 0], [Date.UTC(2026, 9, 13, 5), 0],
    ];
    for (const [at, idle] of timeline) {
      rig.clearBackoff();
      await rig.observe(at, idle);
    }
    expect(rig.deliver.mock.calls.length).toBeGreaterThan(0);
    for (const [candidate] of rig.deliver.mock.calls) {
      expect(candidate.score, candidate.sceneId).toBeLessThan(FOLLOWUP_MIN_SCORE);
      const stored = createDefaultProactiveState();
      Object.assign(stored, { unansweredCount: 1, lastProactiveAt: 0, lastProactiveScene: "different_reason" });
      const decision = canStartProactiveGeneration({ ...rig.runtime, now: Date.UTC(2026, 9, 13, 5), localHour: 14, localMinute: 0 },
        stored, { ...candidate, sceneCooldownMs: 0 });
      expect(decision.allowed, candidate.sceneId).toBe(false);
      expect(decision.reason).toEqual(candidate.sceneId === "back_from_away" ? "followup_score_too_low" : "followup_requires_return");
    }
  });

  it.each(["work_break", "back_from_away"])(
    "allows the final new return at 08:00 after an ignored %s at 14:00 and departure at 17:00", async (firstScene) => {
      const rig = scheduler();
      const sentAt = Date.UTC(2026, 9, 12, 5); // 14:00 Asia/Tokyo
      const decisions: Array<{ allowed: boolean; reason: string }> = [];
      // Establish a real first opportunity: either 90 minutes online or a prior absence.
      if (firstScene === "work_break") await rig.observe(sentAt - 90 * minute, 0);
      else await rig.observe(sentAt - minute, 8 * 3600);
      rig.deliver.mockImplementation(async (candidate) => {
        const parts = getZonedDateParts(new Date(rig.runtime.now), "Asia/Tokyo");
        const decision = canStartProactiveGeneration({ ...rig.runtime, localHour: parts.hour, localMinute: parts.minute }, rig.stored, candidate);
        decisions.push(decision);
        if (decision.allowed) markProactiveCommitted(rig.stored, candidate, rig.runtime.now);
      });
      await rig.observe(sentAt, 0);
      expect(rig.deliver.mock.calls[0][0].sceneId).toBe(firstScene);
      expect(rig.stored.unansweredCount).toBe(1);

      // Depart at 17:00; observe idle at 17:30 and again just before returning next morning.
      await rig.observe(sentAt + 3.5 * hour, 1800);
      await rig.observe(sentAt + 18 * hour - minute, 15 * 3600 - 60);
      await rig.observe(sentAt + 18 * hour, 0);
      expect(rig.deliver.mock.calls).toHaveLength(2);
      expect(rig.deliver.mock.calls[1][0]).toEqual({ sceneId: "back_from_away", score: 85, sceneCooldownMs: 4 * hour });
      expect(decisions).toEqual([{ allowed: true, reason: "allowed" }, { allowed: true, reason: "allowed" }]);
      expect(rig.stored.unansweredCount).toBe(2);

      // Remaining online cannot replay the same edge; even another long absence cannot yield a third message.
      await rig.observe(sentAt + 18 * hour + minute, 0);
      await rig.observe(sentAt + 42 * hour - minute, 23 * 3600);
      await rig.observe(sentAt + 42 * hour, 0);
      expect(rig.deliver.mock.calls).toHaveLength(2);
    },
  );

  it("sends no followup while continuously online from the ignored 14:00 message through 20:00 and the next morning", async () => {
    const rig = scheduler();
    const sentAt = Date.UTC(2026, 9, 12, 5); // 14:00 Asia/Tokyo
    const decisions: Array<{ scene: string; reason: string }> = [];
    rig.deliver.mockImplementation(async (candidate) => {
      const parts = getZonedDateParts(new Date(rig.runtime.now), "Asia/Tokyo");
      const decision = canStartProactiveGeneration({ ...rig.runtime, localHour: parts.hour, localMinute: parts.minute }, rig.stored, candidate);
      decisions.push({ scene: candidate.sceneId, reason: decision.reason });
      if (decision.allowed) markProactiveCommitted(rig.stored, candidate, rig.runtime.now);
    });
    await rig.observe(sentAt - 90 * minute, 0);
    await rig.observe(sentAt, 0);
    expect(rig.stored.unansweredCount).toBe(1);
    for (let offset = 30 * minute; offset <= 6 * hour; offset += 30 * minute) {
      await rig.observe(sentAt + offset, 0);
    }
    expect(decisions.filter((decision) => decision.reason === "allowed")).toEqual([{ scene: "work_break", reason: "allowed" }]);
    expect(decisions).toContainEqual({ scene: "work_break", reason: "followup_cooldown" });
    await rig.observe(sentAt + 18 * hour, 0);
    expect(decisions.at(-1)).toEqual({ scene: "work_break", reason: "followup_requires_return" });
    expect(rig.deliver.mock.calls.every(([candidate]) => candidate.sceneId !== "back_from_away")).toBe(true);
    expect(rig.stored.unansweredCount).toBe(1);
  });
});

describe("timer ownership", () => {
  it("starts only one loop, waits ninety seconds, and cancels all future work on stop", async () => {
    const rig = scheduler();
    rig.controller.start();
    rig.controller.start();
    expect(vi.getTimerCount()).toEqual(1);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(rig.deliver.mock.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(rig.deliver.mock.calls).toHaveLength(1);
    rig.controller.stop();
    expect(vi.getTimerCount()).toEqual(0);
    await vi.advanceTimersByTimeAsync(5 * minute);
    expect(rig.deliver.mock.calls).toHaveLength(1);
  });

  it("schedules another cycle when evaluation rejects", async () => {
    const rig = scheduler();
    rig.deliver.mockRejectedValueOnce(new Error("temporary delivery failure"));
    rig.controller.start();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(rig.deliver.mock.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toEqual(1);
    rig.runtime.now += 31 * minute;
    await vi.advanceTimersByTimeAsync(minute);
    expect(rig.deliver.mock.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toEqual(1);
    rig.controller.stop();
  });

  it("waits for a pending evaluation instead of entering it concurrently", async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const rig = scheduler();
    rig.deliver.mockImplementationOnce(() => waiting);
    rig.controller.start();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(rig.deliver.mock.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(minute);
    expect(rig.deliver.mock.calls).toHaveLength(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toEqual(1);
    rig.controller.stop();
    expect(vi.getTimerCount()).toEqual(0);
  });
});

describe("timezone conversion exposed by the trigger", () => {
  it.each([
    ["UTC", 15], ["America/Los_Angeles", 8], ["Asia/Taipei", 23],
  ] as const)("reports calendar parts in %s", (zone, expectedHour) => {
    expect(getZonedDateParts(new Date(Date.UTC(2026, 9, 5, 15, 42)), zone))
      .toEqual({ year: 2026, month: 10, day: 5, minute: 42, hour: expectedHour });
  });

  it("uses the system calendar when given an invalid timezone", () => {
    const date = new Date(Date.UTC(2026, 9, 5, 15, 42));
    const parts = getZonedDateParts(date, "Invalid/Clock");
    expect(typeof parts.year).toEqual("number");
    expect(typeof parts.hour).toEqual("number");
    expect(parts).toEqual({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes() });
  });
});
