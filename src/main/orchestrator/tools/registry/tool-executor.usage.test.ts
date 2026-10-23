import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ recordSkillUse: vi.fn(), recordToolCall: vi.fn() }));
vi.mock("../../../token-usage-store", () => store);

import { executeToolDefinition } from "./tool-executor";
import type { ToolDefinition } from "./tool-registry";

const tool = (id: string): ToolDefinition => ({ id, name: id, description: id, enabled: true, inputSchema: { type: "object", properties: {} }, execute: async () => "ok" });

describe("skill use counting", () => {
  it("counts an invoke_skill call where every dispatch path passes, whichever skill it names", async () => {
    store.recordSkillUse.mockClear();
    await executeToolDefinition(tool("invoke_skill"), { skill_id: "code-review" });
    expect(store.recordSkillUse).toHaveBeenCalledExactlyOnceWith("code-review");
  });

  it("ignores other tools and an invoke_skill call without a skill id", async () => {
    store.recordSkillUse.mockClear();
    await executeToolDefinition(tool("read_file"), { skill_id: "code-review" });
    await executeToolDefinition(tool("invoke_skill"), {});
    await executeToolDefinition(tool("invoke_skill"), { skill_id: 3 });
    expect(store.recordSkillUse).not.toHaveBeenCalled();
  });
});

describe("tool timing", () => {
  it("records every call's duration, including one that fails or is aborted", async () => {
    store.recordToolCall.mockClear();
    await executeToolDefinition(tool("read_file"), {});
    await executeToolDefinition({ ...tool("bash"), execute: async () => { throw new Error("boom"); } }, {});
    await expect(executeToolDefinition({ ...tool("bash"), execute: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); } }, {})).rejects.toThrow();
    expect(store.recordToolCall).toHaveBeenCalledTimes(3);
    for (const [duration] of store.recordToolCall.mock.calls) expect(duration).toBeGreaterThanOrEqual(0);
  });

  it("counts the step but not the time of a tool that ran a sub-agent, whose time is in the agent's own requests", async () => {
    const { runWithUsageAttribution, runAsSubagent } = await import("../../../usage-attribution");
    store.recordToolCall.mockClear();
    const delegating: ToolDefinition = { ...tool("delegate"), execute: async () => { await new Promise(resolve => setTimeout(resolve, 20)); await runAsSubagent(async () => "done"); return "ok"; } };
    await runWithUsageAttribution({ feature: "work", sessionId: "session-a" }, () => executeToolDefinition(delegating, {}));
    expect(store.recordToolCall).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("does not mistake another parallel tool's sub-agent for its own: only the delegating invocation records zero time", async () => {
    const { runWithUsageAttribution, runAsSubagent } = await import("../../../usage-attribution");
    store.recordToolCall.mockClear();
    const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const reader: ToolDefinition = { ...tool("read_file"), execute: async () => { await pause(60); return "ok"; } };
    const delegating: ToolDefinition = { ...tool("delegate"), execute: async () => { await pause(10); await runAsSubagent(async () => "done"); return "ok"; } };
    await runWithUsageAttribution({ feature: "work", sessionId: "session-a" }, () => Promise.all([executeToolDefinition(reader, {}), executeToolDefinition(delegating, {})]));
    const durations = store.recordToolCall.mock.calls.map(([duration]) => duration as number).sort((left, right) => left - right);
    expect(durations[0]).toBe(0);
    expect(durations[1]).toBeGreaterThanOrEqual(50);
  });
});
