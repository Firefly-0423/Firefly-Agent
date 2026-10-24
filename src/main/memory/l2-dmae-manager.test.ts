import { beforeEach, describe, it, expect, vi } from "vitest";
import type { L2DmaeState, L2Memory } from "./memory-types";
const persistence = vi.hoisted(() => ({ getAllL2DmaeStates: vi.fn(), getL2DmaeState: vi.fn(), initL2DmaeStateIfMissing: vi.fn(), updateL2DmaeState: vi.fn() }));
vi.mock("./memory-store", () => ({ memoryStore: persistence }));
import { L2DmaeManager, L2_DMAE_PARAMS, L2_INTRINSIC_BY_RANK } from "./l2-dmae-manager";
let states: Map<string, L2DmaeState>;
const blank = (l2Id: string): L2DmaeState => ({ l2Id, activation: 0, intrinsicValue: 0, userSilence: 0, modelSilence: 0, recentUserHits: [], state: "archived" });
beforeEach(() => {
    vi.resetAllMocks();
    states = new Map();
    persistence.getAllL2DmaeStates.mockImplementation(async () => [...states.values()]);
    persistence.getL2DmaeState.mockImplementation(async (id) => states.get(id));
    persistence.initL2DmaeStateIfMissing.mockImplementation(async (id) => { if (!states.has(id))
        states.set(id, blank(id)); return states.get(id); });
    persistence.updateL2DmaeState.mockImplementation(async (id, patch) => { const merged = { ...states.get(id), ...patch, l2Id: id }; states.set(id, merged); return merged; });
});
function record(id: string, content: string, status = "active"): L2Memory { return { id, content, triggerText: content, sourceConversationId: "activation-session", createdAt: 83, lastAccessedAt: 83, accessCount: 0, weight: 0, isPinned: false, status, keywords: Array.from(content) } as L2Memory; }
describe("L2 working-memory activation", () => {
    it("publishes the V5 reward and decay contract", () => {
        expect([L2_DMAE_PARAMS.userRewardBase, L2_DMAE_PARAMS.modelRewardBase, L2_DMAE_PARAMS.decayAlpha, L2_DMAE_PARAMS.decayBeta]).toEqual([10, 4, 1, 0.2]);
        expect(L2_INTRINSIC_BY_RANK).toEqual([36, 8, 8, 1]);
    });
    it("activates recalled records in rank order and assigns the top intrinsic value", async () => {
        const manager = new L2DmaeManager();
        const records = [record("rank-one", "计划参加摄影课程"), record("rank-two", "计划整理书架")];
        await manager.updateActivation(records, "本轮消息", "", records.map(item => item.id), 0);
        expect((await manager.getActiveL2ForPrompt(records)).map(item => item.id)).toEqual(["rank-one", "rank-two"]);
        expect(states.get("rank-one")!.intrinsicValue).toEqual(36);
    });
    it("activates matching keywords even when no vector recall occurs", async () => {
        const manager = new L2DmaeManager();
        const memory = record("keyword-record", "喜欢海边骑行");
        await manager.updateActivation([memory], "今天去海边骑行", "", [], 0);
        expect((await manager.getActiveL2ForPrompt([memory])).map(item => item.id)).toEqual(["keyword-record"]);
    });
    it("suppresses repeated rewards within the repeat window", async () => {
        const manager = new L2DmaeManager();
        const memory = record("repeat-record", "周日练习钢琴");
        await manager.updateActivation([memory], "周日练习钢琴", "", [memory.id], 1);
        const initial = states.get(memory.id)!.activation;
        await manager.updateActivation([memory], "周日练习钢琴", "", [memory.id], 2);
        expect(states.get(memory.id)!.activation).toBeLessThanOrEqual(initial + L2_DMAE_PARAMS.userRewardBase * 0.5);
    });
    it("does not advance silence counters for an unhit archived record", async () => {
        const manager = new L2DmaeManager();
        states.set("archive-record", { ...blank("archive-record"), intrinsicValue: 1, userSilence: 100, modelSilence: 100 });
        await manager.loadStates();
        await manager.updateActivation([record("archive-record", "海边骑行", "archived")], "数学作业", "", [], 0);
        expect(states.get("archive-record")).toMatchObject({ userSilence: 100, modelSilence: 100 });
    });
});
