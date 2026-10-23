import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canStartProactiveGeneration, markProactiveCommitted, markUserActivity } from "./proactive-policy";
import type { ProactiveRuntimeSnapshot } from "./proactive-types";

const disk = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: (name: string) => {
  if (name !== "userData") throw new Error(`Unexpected app path: ${name}`);
  return disk.userData;
} } }));

afterEach(() => {
  if (disk.userData) fs.rmSync(disk.userData, { recursive: true, force: true });
  disk.userData = "";
});

describe("unanswered state across restart", () => {
  it.each([1, 2] as const)("retains %i unanswered messages and cooldowns across days until a user message", async (count) => {
    disk.userData = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-plan-b-state-"));
    const store = await import("./proactive-state-store");
    const sentAt = Date.UTC(2026, 9, 20, 6);
    const candidate = { sceneId: "back_from_away", score: 75, sceneCooldownMs: 14_400_000 };
    const state = store.defaultProactiveState();
    for (let index = 0; index < count; index++) markProactiveCommitted(state, candidate, sentAt);
    store.saveProactiveState(state);

    // A fresh module load reads only the persisted file, with no in-memory state carried over.
    vi.resetModules();
    const restartedStore = await import("./proactive-state-store");
    const restored = restartedStore.loadProactiveState();
    expect(restored).toEqual(state);
    const snapshot: ProactiveRuntimeSnapshot = { now: sentAt + 7 * 86_400_000, localHour: 14, localMinute: 0,
      idleSec: 0, enabled: true, screenLocked: false, conversationBusy: false, generationBusy: false };
    expect(canStartProactiveGeneration(snapshot, restored, candidate)).toEqual(count === 1
      ? { allowed: true, reason: "allowed" }
      : { allowed: false, reason: "unanswered_limit" });
    markUserActivity(restored);
    restartedStore.saveProactiveState(restored);
    const afterUserMessage = restartedStore.loadProactiveState();
    expect(afterUserMessage).toEqual({ ...state, unansweredCount: 0, proactiveEpoch: state.proactiveEpoch + 1 });
    expect(canStartProactiveGeneration(snapshot, afterUserMessage, candidate)).toEqual({ allowed: true, reason: "allowed" });
  });
});
