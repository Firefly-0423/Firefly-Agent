import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../logging/logger", () => ({ logger: { info: vi.fn() }, LogTag: { Worldbook: "worldbook" } }));
import { DEFAULT_DMAE_PARAMS, DefaultRewardStrategy, deriveState, DmaeManager, QuadraticResistanceDecay, WorldbookManager, type WorldbookEntry } from "./worldbook";

const entry = (id: string, overrides: Partial<WorldbookEntry> = {}): WorldbookEntry => ({ id, keywords: [id], content: id, priority: 5, permanent: false, enabled: true, intrinsicValue: 60, linkTriggers: [], ...overrides });
const state = (activation = 0) => ({ activation, userSilence: 0, modelSilence: 0, recentUserHits: [] as number[] });
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-worldbook-unit-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("DMAE strategies", () => {
  it.each([[-1, 30, "Archived"], [0, 0, "Archived"], [0.1, 30, "Dormant"], [29.99, 30, "Dormant"], [30, 30, "Active"], [100, 30, "Active"]])("derives state at activation %s and threshold %s", (activation, threshold, expected) => {
    expect(deriveState(activation as number, threshold as number)).toBe(expected);
  });

  it("computes rewards with silence, saturation and repetition gates", () => {
    const strategy = new DefaultRewardStrategy();
    const ctx = { entry: entry("a"), params: DEFAULT_DMAE_PARAMS, snap: { activation: 0, userSilence: 0, modelSilence: 0 }, recentHitCount: 0 };
    expect(strategy.userReward(ctx)).toBe(20);
    expect(strategy.modelReward(ctx)).toBe(8);
    expect(strategy.userReward({ ...ctx, snap: { ...ctx.snap, activation: 50 }, recentHitCount: 2 })).toBe(2.5);
    expect(strategy.userReward({ ...ctx, snap: { ...ctx.snap, activation: 100 } })).toBe(0);
    expect(strategy.userReward({ ...ctx, snap: { ...ctx.snap, activation: 101 } })).toBe(0);
    expect(strategy.userReward({ ...ctx, snap: { ...ctx.snap, userSilence: 3 } })).toBeCloseTo(20 * (1 + 0.5 * Math.log(4)));
    expect(strategy.modelReward({ ...ctx, snap: { ...ctx.snap, userSilence: 3 } })).toBeCloseTo(8 * Math.exp(-0.9));
  });

  it.each([0, -10, 1, 4, 100])("bounds intrinsic value %s when computing quadratic decay", intrinsicValue => {
    const result = new QuadraticResistanceDecay().compute({ entry: entry("a", { intrinsicValue }), snap: { userSilence: 2, modelSilence: 3 }, params: DEFAULT_DMAE_PARAMS });
    expect(result).toBeCloseTo(8.7 / Math.sqrt(Math.max(1, intrinsicValue)));
  });
});

describe("DmaeManager", () => {
  it("merges defaults and manages registered state without including permanent or disabled entries", () => {
    const manager = new DmaeManager<WorldbookEntry>({ params: { maxScore: 80 }, debug: false });
    expect(manager.getParams()).toEqual({ ...DEFAULT_DMAE_PARAMS, maxScore: 80 });
    expect(manager.getDebug()).toBe(false);
    expect(new DmaeManager().getDebug()).toBe(true);
    manager.initEntry("old"); manager.setState("old", state(70));
    manager.initEntries([entry("a"), entry("disabled", { enabled: false }), entry("permanent", { permanent: true })]);
    expect(manager.getState("old")).toBeUndefined();
    expect(manager.getState("a")).toEqual(state());
    expect(manager.getState("disabled")).toBeUndefined();
    expect(manager.getState("permanent")).toBeUndefined();
    manager.removeEntry("a"); expect(manager.getState("a")).toBeUndefined();
    manager.initEntry("a"); manager.clear(); expect(manager.getState("a")).toBeUndefined();
  });

  it("leaves unmatched archived entries unchanged and ignores disabled, permanent and keywordless entries", () => {
    const entries = [entry("a", { keywords: ["needle"] }), entry("disabled", { enabled: false }), entry("permanent", { permanent: true }), entry("empty", { keywords: [] })];
    const manager = new DmaeManager<WorldbookEntry>({ debug: false }); manager.initEntries(entries);
    expect([...manager.updateActivation(entries, "unrelated", "unrelated")]).toEqual([]);
    expect(manager.getState("a")).toEqual(state());
    expect([...manager.updateActivation(entries, "disabled permanent empty", "")]).toEqual([]);
    expect(manager.getState("empty")).toEqual(state());
  });

  it("wakes archived user hits, expires the repeat window and resets silence", () => {
    const e = entry("hit");
    const manager = new DmaeManager<WorldbookEntry>({ debug: false }); manager.initEntries([e]);
    expect([...manager.updateActivation([e], "hit", "", 1)]).toEqual(["hit"]);
    expect(manager.getState(e.id)?.activation).toBeCloseTo(35 + 20 * 0.65 ** 2 / 1.5);
    expect(manager.getState(e.id)).toMatchObject({ userSilence: 0, modelSilence: 0, recentUserHits: [1] });
    manager.updateActivation([e], "hit", "", 7);
    expect(manager.getState(e.id)?.recentUserHits).toEqual([7]);
    manager.updateActivation([e], "", "", 13);
    expect(manager.getState(e.id)).toMatchObject({ userSilence: 1, modelSilence: 1, recentUserHits: [] });
  });

  it("never lets model-only rewards activate archived or dormant entries or grow an active entry", () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const manager = new DmaeManager<WorldbookEntry>({ debug: false }); manager.initEntries(entries);
    manager.setState("b", state(10)); manager.setState("c", state(40));
    manager.updateActivation(entries, "", "a b c");
    expect(manager.getState("a")?.activation).toBe(0);
    expect(manager.getState("b")?.activation).toBeLessThan(10);
    expect(manager.getState("c")?.activation).toBeCloseTo(39.99);
    expect(manager.getState("c")).toMatchObject({ userSilence: 1, modelSilence: 0 });
  });

  it("clamps custom reward and decay outcomes and sorts active entries by activation", () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const manager = new DmaeManager<WorldbookEntry>({ debug: false, rewardStrategy: { userReward: () => 1000, modelReward: () => 0 }, decayStrategy: { compute: () => 0 } });
    manager.initEntries(entries); manager.updateActivation(entries, "a", "");
    expect(manager.getState("a")?.activation).toBe(100);
    manager.setState("b", state(30)); manager.setState("c", state(29));
    expect(manager.getActiveEntries(entries).map(e => e.id)).toEqual(["a", "b"]);
    expect(manager.getActiveEntries(entries, 29).map(e => e.id)).toEqual(["a", "b", "c"]);
    const decay = new DmaeManager<WorldbookEntry>({ debug: false, decayStrategy: { compute: () => 1000 } });
    decay.initEntries(entries); decay.setState("a", state(1)); decay.updateActivation(entries, "", "");
    expect(decay.getState("a")?.activation).toBe(0);
  });
});

describe("WorldbookManager", () => {
  it("tolerates missing or empty directories", async () => {
    const manager = new WorldbookManager(path.join(dir, "missing"), { debug: false });
    await manager.loadFromDirectory(); expect(manager.entriesCount).toBe(0);
    fs.writeFileSync(path.join(dir, "ignored.txt"), "## ignored\ncontent");
    const empty = new WorldbookManager(dir, { debug: false });
    await empty.loadFromDirectory(); expect(empty.getEntries()).toEqual([]);
  });

  it("parses headings, mixed keyword separators, metadata and defaults, omitting empty entries", async () => {
    fs.writeFileSync(path.join(dir, "fixture.md"), "# Book\n## Named Entry\n- 触发词： alpha, beta，gamma、\n- 常驻: yes\n- 优先级: 9\n- 内在价值： 42.5\n- 连带触发： target, second\n- 未知: ignored\n\n body one \nbody two\n---\n## Defaults\n- 优先级: invalid\n- intrinsic_value: NaN\n- link_triggers: none\ncontent\n## Empty\n- 触发词: unused\n");
    const manager = new WorldbookManager(dir, { debug: false }); await manager.loadFromDirectory();
    expect(manager.entriesCount).toBe(2);
    expect(manager.getEntries()).toEqual([
      entry("wb_fixture_Named_Entry", { keywords: ["alpha", "beta", "gamma"], permanent: true, priority: 9, intrinsicValue: 42.5, linkTriggers: ["target", "second"], content: "body one \nbody two" }),
      entry("wb_fixture_Defaults", { keywords: [], content: "content" }),
    ]);
    expect(manager.getPermanentEntries()).toEqual(["body one \nbody two"]);
    expect(manager.getState("wb_fixture_Named_Entry")).toBeUndefined();
    expect(manager.getState("wb_fixture_Defaults")).toEqual(state());
  });

  it.each(["初始分", "initial_score", "内在价值", "intrinsic_value"])("accepts %s value alias with a full-width colon", async alias => {
    fs.writeFileSync(path.join(dir, "alias.md"), `## A\n- ${alias}： 0\n- 连带触发词： 无\ncontent`);
    const manager = new WorldbookManager(dir, { debug: false }); await manager.loadFromDirectory();
    expect(manager.getEntries()[0]).toMatchObject({ intrinsicValue: 0, linkTriggers: [] });
  });

  it("keeps permanent priority order and unique trigger order including disabled entries", () => {
    const manager = new WorldbookManager(dir, { debug: false });
    manager.loadFromEntries([entry("low", { permanent: true, priority: 1, keywords: ["a", "b"] }), entry("high", { permanent: true, priority: 9, keywords: ["b", "c"] }), entry("off", { enabled: false, permanent: true, keywords: ["d"] })]);
    expect(manager.getPermanentEntries()).toEqual(["high", "low"]);
    expect(manager.getAllTriggerWords()).toEqual(["a", "b", "c", "d"]);
    expect(manager.getActiveEntries()).toEqual([]);
  });

  it("orders active ties by priority, limits to eight and formats titles", () => {
    const manager = new WorldbookManager(dir, { debug: false, rewardStrategy: { userReward: () => 0, modelReward: () => 0 }, decayStrategy: { compute: () => 0 } });
    const entries = Array.from({ length: 10 }, (_, i) => entry(`wb_fixture_Title_${i}`, { keywords: ["all"], priority: i }));
    manager.loadFromEntries(entries); manager.updateActivation("all", "", 1);
    expect(manager.getActiveEntries()).toEqual([9, 8, 7, 6, 5, 4, 3, 2].map(i => `【Title ${i}】\nwb_fixture_Title_${i}`));
    expect(manager.getActiveEntries(36)).toEqual([]);
  });

  it("cascades one level, deduplicates targets, excludes direct hits and resets on the next turn", () => {
    const manager = new WorldbookManager(dir, { debug: false });
    manager.loadFromEntries([entry("a", { linkTriggers: ["b", "disabled", "permanent"] }), entry("a2", { keywords: ["a"], linkTriggers: ["b"] }), entry("b", { linkTriggers: ["c"] }), entry("c"), entry("disabled", { enabled: false }), entry("permanent", { permanent: true })]);
    manager.updateActivation("a", "", 1);
    expect(manager.getCascadeEntries().map(e => e.id)).toEqual(["b"]);
    expect(manager.getState("b")).toEqual(state());
    manager.updateActivation("a b", "", 2);
    expect(manager.getCascadeEntries().map(e => e.id)).toEqual(["c"]);
    manager.updateActivation("", "a", 3);
    expect(manager.getCascadeEntries()).toEqual([]);
  });

  it("resets activation on reload and accepts the optional no-op state-file seam", () => {
    const manager = new WorldbookManager(dir, { debug: false, stateFile: path.join(dir, "state.json") });
    manager.loadFromEntries([entry("a")]); manager.updateActivation("a", "", 1);
    expect(manager.getActiveEntries()).toHaveLength(1);
    manager.loadFromEntries([entry("b")]);
    expect(manager.getState("a")).toBeUndefined(); expect(manager.getState("b")).toEqual(state());
    expect(fs.existsSync(path.join(dir, "state.json"))).toBe(false);
  });
});
