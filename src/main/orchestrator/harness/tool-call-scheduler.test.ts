import { describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../vendors/types";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import { classifyToolExecutionMode, scheduleToolCalls, type ToolCallExecution, type ToolCallSchedulerOptions, type ToolExecutionMode } from "./tool-call-scheduler";

function latch<T>() {
  let fulfill!: (value: T) => void, fail!: (error: unknown) => void;
  const value = new Promise<T>((resolve, reject) => { fulfill = resolve; fail = reject; });
  return { value, fulfill, fail };
}
const request = (name: string): ToolCall => ({ id: `invocation-${name}`, arguments: "{}", name });
const definition = (patch: Partial<ToolDefinition> = {}): ToolDefinition => ({
  id: "lookup_record", name: "Lookup record", description: "Inspect persisted facts", enabled: true,
  inputSchema: { type: "object", properties: {} }, effectKind: "read", execute: async () => "Located", ...patch,
});
function pool(names: string[], overrides: Partial<ToolCallSchedulerOptions<string>> = {}) {
  const gates = names.map(() => latch<string>());
  const launched: number[] = [], synthetic: Array<[number, string]> = [], committed: Array<[number, string]> = [];
  const options: ToolCallSchedulerOptions<string> = {
    calls: names.map(request), maxParallel: 2, classify: () => "parallel",
    execute: ({ toolCallIndex: index }) => { launched.push(index); return gates[index].value; },
    notExecuted: async ({ toolCallIndex: index }, reason) => { synthetic.push([index, reason]); return `omitted:${reason}`; },
    commit: async ({ toolCallIndex: index }, value) => { committed.push([index, value]); return "continue"; },
    ...overrides,
  };
  const running = scheduleToolCalls(options);
  return { gates, launched, synthetic, committed, running };
}

describe("Tool concurrency declarations", () => {
  it("defaults to exclusive unless a read explicitly declares current arguments safe", () => {
    const classify = (patch: Partial<ToolDefinition>) => classifyToolExecutionMode(request("lookup_record"), [definition(patch)]);
    expect([classify({}), classify({ isConcurrencySafe: () => true }),
      classify({ effectKind: "mutation", isConcurrencySafe: () => true }),
      classify({ effectKind: "unknown", isConcurrencySafe: () => true }),
      classify({ isConcurrencySafe: () => { throw new Error("Classifier unavailable"); } }),
    ]).toEqual(["exclusive", "parallel", "exclusive", "exclusive", "exclusive"]);
    expect(["update_todo", "task", "read_tool_result", "delegate_agent"].map(name => classifyToolExecutionMode(request(name), [])))
      .toEqual(["exclusive", "exclusive", "parallel", "delegation"]);
  });
});

describe("Ordered settlement of rolling tool pools", () => {
  it("exposes original indices while later completions wait for the first commit", async () => {
    const completed: number[] = [];
    const gates = [latch<string>(), latch<string>(), latch<string>()];
    const job = pool(["east", "west", "north"], {
      maxParallel: 3, execute: async ({ toolCallIndex }) => { const value = await gates[toolCallIndex].value; completed.push(toolCallIndex); return value; },
    });
    await Promise.resolve();
    gates[1].fulfill("west result"); gates[2].fulfill("north result");
    await expect.poll(() => completed).toEqual([1, 2]);
    expect(job.committed).toEqual([]);
    gates[0].fulfill("east result");
    expect(await job.running).toEqual({ cancelled: false, halted: false });
    expect(job.committed).toEqual([[0, "east result"], [1, "west result"], [2, "north result"]]);
  });

  it("replenishes a rolling pool at two active calls without changing commit order", async () => {
    let active = 0, peak = 0;
    const releases = [latch<string>(), latch<string>(), latch<string>()];
    const started: number[] = [];
    const job = pool(["east", "west", "north"], { execute: async ({ toolCallIndex: index }) => {
      started.push(index); peak = Math.max(peak, ++active);
      const answer = await releases[index].value; --active; return answer;
    } });
    await expect.poll(() => started).toEqual([0, 1]);
    releases[1].fulfill("west");
    await expect.poll(() => started).toEqual([0, 1, 2]);
    releases[2].fulfill("north"); releases[0].fulfill("east");
    await job.running;
    expect(peak).toEqual(2);
    expect(job.committed).toEqual([[0, "east"], [1, "west"], [2, "north"]]);
  });

  it("does not pass an exclusive barrier until both earlier calls settle", async () => {
    const job = pool(["east", "west", "barrier"], { classify: call => call.name === "barrier" ? "exclusive" : "parallel" });
    await expect.poll(() => job.launched).toEqual([0, 1]);
    job.gates[1].fulfill("west");
    await Promise.resolve(); await Promise.resolve();
    expect(job.launched).toEqual([0, 1]);
    job.gates[0].fulfill("east");
    await expect.poll(() => job.launched).toEqual([0, 1, 2]);
    job.gates[2].fulfill("barrier");
    await job.running;
    expect(job.launched).toEqual([0, 1, 2]);
  });

  it("synthesizes every call when cancellation precedes dispatch", async () => {
    const job = pool(["east", "west"], { signal: AbortSignal.abort(), maxParallel: 4 });
    expect(await job.running).toEqual({ cancelled: true, halted: false });
    expect(job.launched).toEqual([]);
    expect(job.synthetic).toEqual([[0, "aborted_before_dispatch"], [1, "aborted_before_dispatch"]]);
  });

  it("halts further launches while draining and committing the already launched sibling", async () => {
    const accepted: Array<[number, string]> = [];
    const job = pool(["east", "west", "north", "south"], { commit: async ({ toolCallIndex: index }, value) => {
      accepted.push([index, value]); return index === 0 ? "halt" : "continue";
    } });
    await Promise.resolve();
    job.gates[0].fulfill("east");
    await expect.poll(() => accepted).toEqual([[0, "east"]]);
    job.gates[1].fulfill("west");
    expect(await job.running).toEqual({ cancelled: false, halted: true });
    expect(accepted).toEqual([[0, "east"], [1, "west"], [2, "omitted:not_executed_after_halt"], [3, "omitted:not_executed_after_halt"]]);
    expect(job.synthetic).toEqual([[2, "not_executed_after_halt"], [3, "not_executed_after_halt"]]);
  });

  it.each(["first", "last", "only"] as const)("closes the %s failing execution with a synthetic result before rethrowing", async position => {
    const error = new Error(`Infrastructure failure at ${position}`);
    const job = pool(position === "only" ? ["east"] : ["east", "west"]);
    const rejected = expect(job.running).rejects.toBe(error);
    await Promise.resolve();
    if (position === "last") {
      job.gates[0].fulfill("east");
      await expect.poll(() => job.committed).toEqual([[0, "east"]]);
      job.gates[1].fail(error);
    } else {
      job.gates[0].fail(error);
      if (position !== "only") job.gates[1].fulfill("west");
    }
    await rejected;
    const failedIndex = position === "last" ? 1 : 0;
    expect(job.synthetic).toEqual([[failedIndex, "execution_error"]]);
    expect(job.committed).toEqual(position === "only" ? [[0, "omitted:execution_error"]]
      : position === "last" ? [[0, "east"], [1, "omitted:execution_error"]] : [[0, "omitted:execution_error"], [1, "west"]]);
  });

  it("drains siblings and attempts later commits after a consumer commit fails", async () => {
    const error = new Error("Commit channel unavailable"), calls: number[] = [];
    const job = pool(["east", "west"], { commit: async ({ toolCallIndex: index }) => {
      calls.push(index); if (index === 0) throw error; return "continue";
    } });
    const rejected = expect(job.running).rejects.toBe(error);
    await Promise.resolve();
    job.gates[0].fulfill("east"); job.gates[1].fulfill("west");
    await rejected;
    expect(calls).toEqual([0, 1]);
  });

  it("preserves committed facts and leaves aborted started slots for recovery", async () => {
    const controller = new AbortController();
    const job = pool(["east", "west", "north", "south"], { signal: controller.signal });
    await Promise.resolve();
    job.gates[0].fulfill("east");
    await expect.poll(() => job.committed).toEqual([[0, "east"]]);
    expect(job.launched).toEqual([0, 1, 2]);
    controller.abort(); job.gates[1].fail(new Error("Stopped west")); job.gates[2].fail(new Error("Stopped north"));
    expect(await job.running).toEqual({ cancelled: true, halted: false });
    expect(job.synthetic).toEqual([[3, "aborted_before_dispatch"]]);
    expect(job.committed).toEqual([[0, "east"], [3, "omitted:aborted_before_dispatch"]]);
  });

  it("does not mislabel an interrupted exclusive operation as never dispatched", async () => {
    const controller = new AbortController();
    const job = pool(["send_report", "inspect"], { signal: controller.signal, classify: () => "exclusive" });
    expect(job.launched).toEqual([0]);
    controller.abort(); job.gates[0].fail(new Error("Exclusive operation interrupted"));
    expect(await job.running).toEqual({ cancelled: true, halted: false });
    expect(job.synthetic).toEqual([[1, "aborted_before_dispatch"]]);
    expect(job.committed).toEqual([[1, "omitted:aborted_before_dispatch"]]);
  });

  it("closes an exclusive execution failure and every undispatched following call", async () => {
    const error = new Error("Exclusive dispatch failed");
    const job = pool(["barrier", "inspect"], { classify: entry => entry.name === "barrier" ? "exclusive" : "parallel" });
    const rejected = expect(job.running).rejects.toBe(error);
    job.gates[0].fail(error);
    await rejected;
    expect(job.committed).toEqual([[0, "omitted:execution_error"], [1, "omitted:not_executed_after_error"]]);
    expect(job.synthetic).toEqual([[0, "execution_error"], [1, "not_executed_after_error"]]);
  });
});

describe("Delegation scope and independent capacity", () => {
  it.each([1, 2, 4])("caps child concurrency at min(3, %i) and shares a trusted group identity", async maxParallel => {
    const scopes: ToolCallExecution["delegationScope"][] = [];
    const gates = Array.from({ length: 4 }, () => latch<string>());
    let active = 0, peak = 0;
    const started: number[] = [];
    const calls = ["analyst", "editor", "tester", "archivist"].map(agent => ({ id: `child-${agent}`, name: "delegate_agent", arguments: JSON.stringify({ agent_id: agent, prompt: "Inspect assigned artifacts" }) }));
    const result = scheduleToolCalls({ calls, maxParallel, classify: call => classifyToolExecutionMode(call, []),
      execute: async execution => { started.push(execution.toolCallIndex); scopes.push(execution.delegationScope); peak = Math.max(peak, ++active); const value = await gates[execution.toolCallIndex].value; --active; return value; },
      commit: async () => "continue", notExecuted: async () => "omitted",
    });
    try { await expect.poll(() => started.length).toEqual(Math.min(3, maxParallel)); }
    finally { gates.forEach(gate => gate.fulfill("Complete")); await result; }
    expect(peak).toEqual(Math.min(3, maxParallel));
    expect(scopes).toEqual(calls.map(call => ({ groupId: expect.any(String), toolCallId: call.id })));
    expect(new Set(scopes.map(scope => scope!.groupId)).size).toEqual(1);
  });

  it("holds every commit until the partners running beside it have settled", async () => {
    const f = pool(["child-a", "lookup", "child-b"], { classify: call => call.name.startsWith("child") ? "delegation" : "parallel", maxParallel: 3 });
    await expect.poll(() => f.launched.length).toEqual(3);
    f.gates[0].fulfill("A"); f.gates[1].fulfill("L");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.committed).toEqual([]);
    f.gates[2].fulfill("B"); await f.running;
    expect(f.committed).toEqual([[0, "A"], [1, "L"], [2, "B"]]);
  });

  const mixedMode = (entry: ToolCall): ToolExecutionMode => entry.name === "barrier" ? "exclusive" : entry.name.startsWith("child") ? "delegation" : "parallel";
  it.each(["halt", "cancel"] as const)("closes noncontiguous undispatched slots exactly once on %s", async outcome => {
    const controller = new AbortController();
    const commits: Array<[number, string]> = [];
    const job = pool(["child-east", "child-west", "child-north", "read-east", "read-west", "barrier"], {
      classify: mixedMode, signal: controller.signal,
      commit: async ({ toolCallIndex: index }, value) => { commits.push([index, value]); return outcome === "halt" && index === 0 ? "halt" : "continue"; },
    });
    await expect.poll(() => job.launched).toEqual([0, 1, 3, 4]);
    if (outcome === "halt") {
      // The halting result commits once its sibling partner settles; nothing launches in between.
      job.gates[0].fulfill("Stop launching");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(commits).toEqual([]); expect(job.launched).toEqual([0, 1, 3, 4]);
      for (const index of [1, 3, 4]) job.gates[index].fulfill("Settled");
    } else {
      controller.abort(); job.gates[0].fail(new Error("Stopped child")); job.gates[1].fail(new Error("Stopped sibling"));
      job.gates[3].fulfill("East read"); job.gates[4].fulfill("West read");
    }
    expect(await job.running).toEqual({ cancelled: outcome === "cancel", halted: outcome === "halt" });
    expect(job.launched).toEqual([0, 1, 3, 4]);
    expect(job.synthetic).toEqual([[2, outcome === "halt" ? "not_executed_after_halt" : "aborted_before_dispatch"], [5, outcome === "halt" ? "not_executed_after_halt" : "aborted_before_dispatch"]]);
    expect(commits).toEqual(outcome === "halt"
      ? [[0, "Stop launching"], [1, "Settled"], [2, "omitted:not_executed_after_halt"], [3, "Settled"], [4, "Settled"], [5, "omitted:not_executed_after_halt"]]
      : [[2, "omitted:aborted_before_dispatch"], [3, "East read"], [4, "West read"], [5, "omitted:aborted_before_dispatch"]]);
  });

  it("closes a child group after all original promises settle and before the next barrier", async () => {
    const trace: string[] = [];
    const gates = [latch<string>(), latch<string>()];
    const run = scheduleToolCalls({ calls: ["child-east", "child-west", "barrier"].map(request), maxParallel: 3, classify: mixedMode,
      execute: async ({ toolCallIndex: index }) => { trace.push(`launch ${index}`); return index < 2 ? gates[index].value : "Barrier"; },
      commit: async () => "continue", notExecuted: async () => "omitted", closeGroup: async () => { trace.push("close"); },
    });
    await expect.poll(() => trace).toEqual(["launch 0", "launch 1"]);
    gates[0].fulfill("East");
    await Promise.resolve();
    expect(trace).not.toContain("close");
    gates[1].fulfill("West");
    await run;
    expect(trace).toEqual(["launch 0", "launch 1", "close", "launch 2"]);
  });

  it("quiesces on synthesis failure before draining real work and only then closes the group", async () => {
    const controller = new AbortController(), released = latch<string>();
    const failure = new Error("Synthetic observation could not be persisted");
    const trace: string[] = [];
    let settled = false;
    const run = scheduleToolCalls({
      calls: ["child-east", "child-west", "read"].map(request), maxParallel: 1, signal: controller.signal,
      classify: entry => entry.name === "read" ? "parallel" : "delegation",
      execute: async ({ call }) => {
        trace.push(call.name);
        if (call.name !== "read") return "Child result";
        await new Promise<void>(resolve => controller.signal.aborted ? resolve() : controller.signal.addEventListener("abort", () => resolve(), { once: true }));
        trace.push("saw cancellation"); const answer = await released.value; trace.push("actual settlement"); return answer;
      },
      commit: async () => "halt", notExecuted: async () => { throw failure; },
      onFailure: error => { expect(error).toBe(failure); trace.push("quiesce"); controller.abort(); },
      closeGroup: async () => { trace.push("closed group"); },
    }).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    try {
      await expect.poll(() => trace.includes("saw cancellation")).toBe(true);
      expect(trace).toEqual(["child-east", "read", "quiesce", "saw cancellation"]);
      expect(settled).toBe(false);
      released.fulfill("Actual read fact");
      expect(await run).toEqual({ error: failure });
      expect(trace.slice(-2)).toEqual(["actual settlement", "closed group"]);
    } finally { controller.abort(); released.fulfill("Cleanup"); await run; }
  });

  it.each(["parallel", "exclusive"] as const)("keeps the original %s execution error through owned cancellation and synthesis failure", async mode => {
    const controller = new AbortController(), original = new Error("Primary infrastructure failure");
    const notify = vi.fn(() => controller.abort());
    await expect(scheduleToolCalls({
      calls: ["east", "west"].map(request), maxParallel: 1, signal: controller.signal, classify: () => mode,
      execute: async () => { throw original; }, commit: async () => "continue",
      notExecuted: async () => { throw new Error("Secondary persistence failure"); }, onFailure: notify,
    })).rejects.toBe(original);
    expect(notify).toHaveBeenCalledExactlyOnceWith(original);
  });

  it("retains the first delegation error even if group cleanup also throws", async () => {
    const original = new Error("Primary child infrastructure failure"), notify = vi.fn();
    await expect(scheduleToolCalls({
      calls: [request("child-east")], maxParallel: 1, classify: () => "delegation",
      execute: async () => { throw original; }, commit: async () => "continue", notExecuted: async () => "Failure fact",
      onFailure: notify, closeGroup: async () => { throw new Error("Secondary cleanup failure"); },
    })).rejects.toBe(original);
    expect(notify).toHaveBeenCalledExactlyOnceWith(original);
  });
});
