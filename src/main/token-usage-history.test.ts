import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: { getPath: () => { throw new Error("direct Electron path access forbidden"); } } }));

const roots: string[] = [];
function temporary() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-usage-history-")); roots.push(root); return root; }
beforeEach(() => vi.resetModules());
afterEach(async () => { const token = await import("./token-usage-store"); token.flush(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function setup(root = temporary()) {
  const { resolveRuntimeProfile } = await import("./runtime-profile");
  const { initializeStorageContext } = await import("./storage-context");
  return initializeStorageContext(resolveRuntimeProfile({ isPackaged: true, env: {}, productionAppData: temporary(), argv: ["--firefly-profile=test", `--firefly-isolation-root=${root}`] }));
}

describe("usage attribution", () => {
  it("bills a request to the feature and conversation declared by the run, and only inside it", async () => {
    await setup();
    const token = await import("./token-usage-store");
    const { runWithUsageAttribution, runAsSubagent } = await import("./usage-attribution");
    await runWithUsageAttribution({ feature: "work", sessionId: "session-a" }, async () => {
      await Promise.resolve();
      token.recordUsage(100, 20, 1, undefined, "model-x");
      await runAsSubagent(async () => { await Promise.resolve(); token.recordUsage(40, 10, 1, undefined, "model-x"); });
    });
    token.recordUsage(7, 3, 1, undefined, "model-x");
    token.recordUsage(5, 5, 1, undefined, "model-y", undefined, "memory");

    const history = token.getUsageHistory(1);
    const names = Object.fromEntries(history.features.map(item => [item.name, item.tokens]));
    expect(names).toEqual({ work: 120, subagent: 50, other: 10, memory: 10 });
    // The sub-agent counts toward the parent conversation; the unattributed request has no conversation.
    expect(history.sessions).toEqual([{ id: "session-a", feature: "work", tokens: 170, requests: 2 }]);
    expect(history.days[0]!.tokens).toBe(190);
    expect(history.days[0]!.byFeature).toEqual({ work: 120, subagent: 50, other: 10, memory: 10 });
    expect(history.models.map(item => [item.name, item.tokens])).toEqual([["model-x", 180], ["model-y", 10]]);
  });

  it("counts messages, skill calls and plugin calls per day, ignoring names that could poison a record", async () => {
    await setup();
    const token = await import("./token-usage-store");
    token.recordMessage(); token.recordMessage();
    token.recordSkillUse("code-review"); token.recordSkillUse("code-review"); token.recordSkillUse("writing"); token.recordSkillUse("__proto__"); token.recordSkillUse("  ");
    token.recordPluginCall("minecraft"); token.recordPluginCall("constructor");

    const history = token.getUsageHistory(1);
    expect(history.skills).toEqual([{ id: "code-review", count: 2 }, { id: "writing", count: 1 }]);
    expect(history.plugins).toEqual([{ id: "minecraft", count: 1 }]);
    expect(history.days[0]).toEqual(expect.objectContaining({ messages: 2, skillCalls: 3, pluginCalls: 1 }));
  });

  it("keeps only the biggest sessions of a day and ranks the top ten", async () => {
    await setup();
    const token = await import("./token-usage-store");
    const { runWithUsageAttribution } = await import("./usage-attribution");
    for (let index = 1; index <= 70; index += 1) {
      runWithUsageAttribution({ feature: "chat", sessionId: `session-${index}` }, () => token.recordUsage(index * 10, 0));
    }
    const history = token.getUsageHistory(1);
    expect(history.sessions).toHaveLength(10);
    expect(history.sessions[0]).toEqual(expect.objectContaining({ id: "session-70", tokens: 700 }));
    // The smallest sessions were dropped from the day's detail, but the day's own total is untouched.
    expect(history.sessions.map(item => item.id)).not.toContain("session-1");
    expect(history.days[0]!.tokens).toBe(10 * (70 * 71) / 2);
  });

  it("evicts the true smallest session when a day is full, even if it is the one just seen", async () => {
    const storage = await setup();
    const token = await import("./token-usage-store");
    const { runWithUsageAttribution } = await import("./usage-attribution");
    const retained = () => {
      token.flush();
      const day = Object.values(JSON.parse(fs.readFileSync(storage.files.tokenUsage, "utf8")).days)[0] as { sessions: Record<string, unknown> };
      return Object.keys(day.sessions);
    };
    for (let index = 1; index <= 60; index += 1) runWithUsageAttribution({ feature: "chat", sessionId: `big-${index}` }, () => token.recordUsage(1000 + index, 0));
    // A 61st, tiny conversation must not displace any of the 60 substantial ones.
    runWithUsageAttribution({ feature: "chat", sessionId: "tiny" }, () => token.recordUsage(1, 0));
    expect(retained()).toHaveLength(60);
    expect(retained()).not.toContain("tiny");
    expect(retained()).toContain("big-1");
    // Whereas a substantial newcomer pushes out the smallest existing one.
    runWithUsageAttribution({ feature: "chat", sessionId: "huge" }, () => token.recordUsage(50_000, 0));
    expect(retained()).toContain("huge");
    expect(retained()).not.toContain("big-1");
    expect(retained()).toHaveLength(60);
  });

  it("reloads the new fields from disk and still reads older files that lack them", async () => {
    const root = temporary();
    const storage = await setup(root);
    const token = await import("./token-usage-store");
    const { runWithUsageAttribution } = await import("./usage-attribution");
    runWithUsageAttribution({ feature: "code", sessionId: "session-a" }, () => token.recordUsage(30, 10));
    token.recordSkillUse("writing");
    token.flush();
    const saved = JSON.parse(fs.readFileSync(storage.files.tokenUsage, "utf8"));
    const key = Object.keys(saved.days)[0]!;
    // An older day: counters only.
    saved.days["2000-01-01"] = { input: 1, output: 1, hit: 0, miss: 0, cacheCreation: 0, requests: 1 };
    fs.writeFileSync(storage.files.tokenUsage, JSON.stringify(saved));

    vi.resetModules();
    await setup(root);
    const reloaded = await import("./token-usage-store");
    const history = reloaded.getUsageHistory(1);
    expect(history.features).toEqual([{ name: "code", tokens: 40, requests: 1 }]);
    expect(history.skills).toEqual([{ id: "writing", count: 1 }]);
    expect(Object.keys(JSON.parse(fs.readFileSync(storage.files.tokenUsage, "utf8")).days)).toContain(key);
  });
});

describe("session stats", () => {
  it("adds up rounds, steps, model and tool time, first-token delay and output speed for one conversation", async () => {
    await setup();
    const token = await import("./token-usage-store");
    const { runWithUsageAttribution } = await import("./usage-attribution");
    runWithUsageAttribution({ feature: "work", sessionId: "session-a" }, () => {
      token.recordMessage();
      token.recordModelCall({ durationMs: 4000, ttftMs: 1000, generationMs: 3000, outputTokens: 600 });
      token.recordToolCall(2500);
      token.recordModelCall({ durationMs: 2000, ttftMs: 3000, generationMs: 1000, outputTokens: 200 });
      token.recordMessage();
    });
    runWithUsageAttribution({ feature: "chat", sessionId: "session-b" }, () => token.recordToolCall(10));

    expect(token.getSessionStats("session-a")).toEqual({ rounds: 2, steps: 3, modelMs: 6000, toolMs: 2500, avgTtftMs: 2000, tokensPerSecond: 200 });
    expect(token.getSessionStats("session-b")).toEqual(expect.objectContaining({ steps: 1, toolMs: 10, avgTtftMs: null, tokensPerSecond: null }));
    expect(token.getSessionStats("missing")).toBeNull();
    expect(token.getSessionStats("__proto__")).toBeNull();
  });

  it("ignores timing recorded outside a conversation, and non-stream calls give no first-token or speed", async () => {
    await setup();
    const token = await import("./token-usage-store");
    const { runWithUsageAttribution } = await import("./usage-attribution");
    token.recordModelCall({ durationMs: 500 });
    runWithUsageAttribution({ feature: "memory" }, () => token.recordToolCall(5));
    runWithUsageAttribution({ feature: "code", sessionId: "session-a" }, () => token.recordModelCall({ durationMs: 800, outputTokens: 100 }));
    expect(token.getSessionStats("session-a")).toEqual({ rounds: 0, steps: 1, modelMs: 800, toolMs: 0, avgTtftMs: null, tokensPerSecond: null });
  });

  it("sums a conversation across days and survives a reload from disk", async () => {
    const root = temporary();
    const storage = await setup(root);
    const token = await import("./token-usage-store");
    const { runWithUsageAttribution } = await import("./usage-attribution");
    runWithUsageAttribution({ feature: "code", sessionId: "session-a" }, () => { token.recordMessage(); token.recordToolCall(1000); });
    token.flush();
    const saved = JSON.parse(fs.readFileSync(storage.files.tokenUsage, "utf8"));
    saved.days["2000-01-01"] = { input: 0, output: 0, hit: 0, miss: 0, cacheCreation: 0, requests: 0, sessionStats: { "session-a": { rounds: 3, steps: 5, modelMs: 9000, toolMs: 500, ttftMs: 2000, ttftCount: 2, genMs: 4000, genTokens: 800 } } };
    fs.writeFileSync(storage.files.tokenUsage, JSON.stringify(saved));

    vi.resetModules();
    await setup(root);
    const reloaded = await import("./token-usage-store");
    expect(reloaded.getSessionStats("session-a")).toEqual({ rounds: 4, steps: 6, modelMs: 9000, toolMs: 1500, avgTtftMs: 1000, tokensPerSecond: 200 });
  });

  it("keeps a conversation's stats when its day is already full of bigger sessions, and when its first call comes before any tokens", async () => {
    await setup();
    const token = await import("./token-usage-store");
    const { runWithUsageAttribution } = await import("./usage-attribution");
    for (let index = 1; index <= 60; index += 1) {
      runWithUsageAttribution({ feature: "chat", sessionId: `big-${index}` }, () => token.recordUsage(1000 + index, 0));
    }
    runWithUsageAttribution({ feature: "work", sessionId: "newcomer" }, () => {
      token.recordMessage();
      token.recordModelCall({ durationMs: 900, ttftMs: 300, generationMs: 600, outputTokens: 90 });
      token.recordUsage(10, 90);
    });
    expect(token.getSessionStats("newcomer")).toEqual({ rounds: 1, steps: 1, modelMs: 900, toolMs: 0, avgTtftMs: 300, tokensPerSecond: 150 });
  });

  it("does not let a sub-agent's tool run count twice: only the step is recorded for a delegating tool", async () => {
    await setup();
    const { runWithUsageAttribution, runAsSubagent, currentUsageAttribution } = await import("./usage-attribution");
    await runWithUsageAttribution({ feature: "work", sessionId: "session-a" }, async () => {
      const attribution = currentUsageAttribution()!;
      expect(attribution.delegations).toBeUndefined();
      await runAsSubagent(async () => undefined);
      expect(attribution.delegations).toBe(1);
    });
  });

  it("counts skills and plugins named like inherited object members as plain numbers", async () => {
    await setup();
    const token = await import("./token-usage-store");
    token.recordSkillUse("toString"); token.recordSkillUse("toString"); token.recordPluginCall("valueOf");
    const history = token.getUsageHistory(1);
    expect(history.skills).toEqual([{ id: "toString", count: 2 }]);
    expect(history.plugins).toEqual([{ id: "valueOf", count: 1 }]);
  });
});
