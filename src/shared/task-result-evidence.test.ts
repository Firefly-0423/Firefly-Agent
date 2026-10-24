import { describe, expect, it } from "vitest";
import { normalizeToolTaskResult } from "./task-result-evidence";

const base = {
  agentId: "agent-1",
  sessionId: "session-1",
  status: "completed",
  text: "done",
};

const event = (overrides: Record<string, unknown> = {}) => ({
  id: "event-1",
  seq: 1,
  monotonicMs: 12.5,
  clockDomainId: "clock",
  agentId: "agent-1",
  parentRunId: "parent-run-1",
  childRunId: "child-1",
  executionId: "execution-1",
  phase: "start",
  ...overrides,
});

const write = (overrides: Record<string, unknown> = {}) => ({
  path: "src/a.ts",
  canonicalPath: "C:\\repo\\src\\a.ts",
  agentId: "agent-1",
  childRunId: "child-1",
  toolCallId: "tool-call-1",
  state: "applied",
  eventIds: ["event-1"],
  ...overrides,
});

describe("normalizeToolTaskResult top-level validation", () => {
  it("returns a minimal result containing only known fields", () => {
    expect(normalizeToolTaskResult(base)).toEqual({
      agentId: "agent-1",
      sessionId: "session-1",
      status: "completed",
      text: "done",
    });
    expect(normalizeToolTaskResult({ ...base, unexpected: "drop me" })).toEqual({
      agentId: "agent-1",
      sessionId: "session-1",
      status: "completed",
      text: "done",
    });
  });

  it.each(["running", "completed", "failed", "cancelled", "interrupted"])("accepts the %s status", (status) => {
    expect(normalizeToolTaskResult({ ...base, status })).toMatchObject({ status });
  });

  it.each([null, undefined, 0, 1, "", "result", [], true])("rejects a non-record payload %j", (value) => {
    expect(normalizeToolTaskResult(value)).toBeUndefined();
  });

  it.each([
    ["missing agentId", { agentId: undefined }],
    ["blank agentId", { agentId: "   " }],
    ["agentId with newline", { agentId: "agent\n1" }],
    ["agentId with carriage return", { agentId: "agent\r1" }],
    ["agentId with NUL", { agentId: "agent\0" }],
    ["missing sessionId", { sessionId: undefined }],
    ["blank sessionId", { sessionId: " " }],
    ["missing status", { status: undefined }],
    ["unknown status", { status: "pending" }],
    ["non-string status", { status: 1 }],
    ["missing text", { text: undefined }],
    ["non-string text", { text: 7 }],
    ["non-boolean truncated", { truncated: "yes" }],
    ["writes is not an array", { writes: {} }],
    ["executionEvents is not an array", { executionEvents: {} }],
  ])("rejects %s", (_label, overrides) => {
    expect(normalizeToolTaskResult({ ...base, ...overrides })).toBeUndefined();
  });

  it("accepts an empty result text", () => {
    expect(normalizeToolTaskResult({ ...base, text: "" })).toMatchObject({ text: "" });
  });
});

describe("normalizeToolTaskResult text truncation", () => {
  it("keeps text of exactly the display limit untruncated", () => {
    const text = "x".repeat(64_000);
    const result = normalizeToolTaskResult({ ...base, text });
    expect(result?.text).toHaveLength(64_000);
    expect(result?.text).toBe(text);
    expect(result).not.toHaveProperty("truncated");
  });

  it("truncates text one character over the display limit and marks it", () => {
    const result = normalizeToolTaskResult({ ...base, text: "x".repeat(64_001) });
    expect(result?.text).toHaveLength(64_000);
    expect(result).toMatchObject({ truncated: true });
  });

  it("keeps an explicit truncated flag only when true", () => {
    expect(normalizeToolTaskResult({ ...base, text: "short", truncated: true })).toMatchObject({ truncated: true });
    expect(normalizeToolTaskResult({ ...base, text: "short", truncated: false })).not.toHaveProperty("truncated");
  });
});

describe("normalizeToolTaskResult writes", () => {
  it("accepts all write states and preserves write order", () => {
    const writes = [
      write({ state: "applied", path: "a.ts" }),
      write({ state: "partially_applied", path: "b.ts" }),
      write({ state: "unknown", path: "c.ts" }),
      write({ state: "not_applied", path: "d.ts" }),
    ];
    const result = normalizeToolTaskResult({ ...base, writes });
    expect(result?.writes?.map(item => [item.path, item.state])).toEqual([
      ["a.ts", "applied"],
      ["b.ts", "partially_applied"],
      ["c.ts", "unknown"],
      ["d.ts", "not_applied"],
    ]);
  });

  it("copies the eventIds array instead of exposing the input array", () => {
    const eventIds = ["event-1", "event-2"];
    const result = normalizeToolTaskResult({ ...base, writes: [write({ eventIds })] });
    eventIds.push("event-3");
    expect(result?.writes?.[0].eventIds).toEqual(["event-1", "event-2"]);
  });

  it("accepts an empty writes array", () => {
    expect(normalizeToolTaskResult({ ...base, writes: [] })).toMatchObject({ writes: [] });
  });

  it("normalizes optional before/after file versions and omits absent evidence", () => {
    const sha = "A".repeat(64);
    const result = normalizeToolTaskResult({
      ...base,
      writes: [write({ before: { sha256: sha, version: "v1" }, after: {} })],
    });
    expect(result?.writes?.[0].before).toEqual({ sha256: sha, version: "v1" });
    expect(result?.writes?.[0].after).toEqual({});
    expect(normalizeToolTaskResult({ ...base, writes: [write()] })?.writes?.[0]).not.toHaveProperty("before");
  });

  it.each([
    ["missing path", { path: undefined }],
    ["blank path", { path: " " }],
    ["path with newline", { path: "a\nb" }],
    ["missing canonicalPath", { canonicalPath: undefined }],
    ["blank canonicalPath", { canonicalPath: "" }],
    ["mismatched agentId", { agentId: "agent-2" }],
    ["missing childRunId", { childRunId: undefined }],
    ["blank childRunId", { childRunId: " " }],
    ["missing toolCallId", { toolCallId: undefined }],
    ["blank toolCallId", { toolCallId: "" }],
    ["unknown state", { state: "done" }],
    ["missing eventIds", { eventIds: undefined }],
    ["eventIds not an array", { eventIds: "event-1" }],
    ["blank eventId", { eventIds: [""] }],
    ["eventId with newline", { eventIds: ["event\n1"] }],
    ["before is null", { before: null }],
    ["before is an array", { before: [] }],
    ["before sha256 is short", { before: { sha256: "a".repeat(63) } }],
    ["before sha256 is not hex", { before: { sha256: "g".repeat(64) } }],
    ["before sha256 is not a string", { before: { sha256: 1 } }],
    ["before version is blank", { before: { version: " " } }],
    ["before version has NUL", { before: { version: "a\0b" } }],
    ["after sha256 is invalid", { after: { sha256: "not-a-digest" } }],
  ])("rejects a write with %s", (_label, overrides) => {
    expect(normalizeToolTaskResult({ ...base, writes: [write(overrides)] })).toBeUndefined();
  });

  it("rejects writes belonging to different child runs", () => {
    expect(normalizeToolTaskResult({
      ...base,
      writes: [write({ childRunId: "child-1" }), write({ childRunId: "child-2" })],
    })).toBeUndefined();
  });
});

describe("normalizeToolTaskResult execution events", () => {
  it("accepts every phase and terminal value", () => {
    const result = normalizeToolTaskResult({
      ...base,
      executionEvents: [
        event({ id: "e1", phase: "start" }),
        event({ id: "e2", phase: "end", terminal: "completed" }),
        event({ id: "e3", phase: "end", terminal: "failed" }),
        event({ id: "e4", phase: "terminal", terminal: "cancelled" }),
      ],
    });
    expect(result?.executionEvents?.map(item => [item.phase, item.terminal])).toEqual([
      ["start", undefined],
      ["end", "completed"],
      ["end", "failed"],
      ["terminal", "cancelled"],
    ]);
  });

  it("requires the event agent and parent run to match the result", () => {
    expect(normalizeToolTaskResult({ ...base, executionEvents: [event()] }, "parent-run-1")).toMatchObject({
      executionEvents: [{ parentRunId: "parent-run-1" }],
    });
    expect(normalizeToolTaskResult({ ...base, executionEvents: [event()] }, "other-parent")).toBeUndefined();
    expect(normalizeToolTaskResult({ ...base, executionEvents: [event({ agentId: "agent-2" })] })).toBeUndefined();
  });

  it("accepts seq one, max safe integer, and non-negative finite timestamps", () => {
    expect(normalizeToolTaskResult({
      ...base,
      executionEvents: [event({ seq: 1, monotonicMs: 0 }), event({ id: "e2", seq: Number.MAX_SAFE_INTEGER, monotonicMs: 0.001 })],
    })?.executionEvents?.map(item => item.seq)).toEqual([1, Number.MAX_SAFE_INTEGER]);
  });

  it("rejects seq zero because the recorder numbers events from one", () => {
    expect(normalizeToolTaskResult({ ...base, executionEvents: [event({ seq: 0 })] })).toBeUndefined();
  });

  it("accepts an empty executionEvents array", () => {
    expect(normalizeToolTaskResult({ ...base, executionEvents: [] })).toMatchObject({ executionEvents: [] });
  });

  it("drops unknown event fields", () => {
    const result = normalizeToolTaskResult({ ...base, executionEvents: [event({ extra: "drop" })] });
    expect(result?.executionEvents?.[0]).not.toHaveProperty("extra");
  });

  it.each([
    ["missing id", { id: undefined }],
    ["blank id", { id: " " }],
    ["id with newline", { id: "a\nb" }],
    ["negative seq", { seq: -1 }],
    ["fractional seq", { seq: 1.5 }],
    ["unsafe seq", { seq: Number.MAX_SAFE_INTEGER + 1 }],
    ["NaN seq", { seq: Number.NaN }],
    ["seq as string", { seq: "1" }],
    ["negative monotonicMs", { monotonicMs: -0.1 }],
    ["infinite monotonicMs", { monotonicMs: Number.POSITIVE_INFINITY }],
    ["NaN monotonicMs", { monotonicMs: Number.NaN }],
    ["missing clockDomainId", { clockDomainId: undefined }],
    ["missing parentRunId", { parentRunId: undefined }],
    ["blank parentRunId", { parentRunId: " " }],
    ["missing childRunId", { childRunId: undefined }],
    ["missing executionId", { executionId: undefined }],
    ["unknown phase", { phase: "delta" }],
    ["missing phase", { phase: undefined }],
    ["unknown terminal", { phase: "end", terminal: "timeout" }],
    ["non-string terminal", { phase: "end", terminal: 1 }],
  ])("rejects an event with %s", (_label, overrides) => {
    expect(normalizeToolTaskResult({ ...base, executionEvents: [event(overrides)] })).toBeUndefined();
  });

  it("rejects events belonging to different child runs", () => {
    expect(normalizeToolTaskResult({
      ...base,
      executionEvents: [event({ childRunId: "child-1" }), event({ id: "e2", childRunId: "child-2" })],
    })).toBeUndefined();
  });

  it("rejects writes that do not belong to the execution event child run", () => {
    expect(normalizeToolTaskResult({
      ...base,
      executionEvents: [event({ childRunId: "child-1" })],
      writes: [write({ childRunId: "child-2" })],
    })).toBeUndefined();
  });

  it("accepts writes and events sharing one child run", () => {
    const result = normalizeToolTaskResult({
      ...base,
      executionEvents: [event({ childRunId: "child-1" })],
      writes: [write({ childRunId: "child-1" })],
    });
    expect(result?.executionEvents?.[0].childRunId).toBe("child-1");
    expect(result?.writes?.[0].childRunId).toBe("child-1");
  });
});

describe("normalizeToolTaskResult error", () => {
  it("keeps only code and message", () => {
    expect(normalizeToolTaskResult({
      ...base,
      status: "failed",
      error: { code: "TASK_FAILED", message: "boom", extra: "drop" },
    })).toMatchObject({ error: { code: "TASK_FAILED", message: "boom" } });
  });

  it("accepts an empty error message", () => {
    expect(normalizeToolTaskResult({ ...base, error: { code: "E", message: "" } })).toMatchObject({
      error: { code: "E", message: "" },
    });
  });

  it.each([
    ["error is null", { error: null }],
    ["error is an array", { error: [] }],
    ["missing code", { error: { message: "boom" } }],
    ["blank code", { error: { code: " ", message: "boom" } }],
    ["code with newline", { error: { code: "E\n1", message: "boom" } }],
    ["missing message", { error: { code: "E" } }],
    ["non-string message", { error: { code: "E", message: 1 } }],
  ])("rejects %s", (_label, overrides) => {
    expect(normalizeToolTaskResult({ ...base, ...overrides })).toBeUndefined();
  });
});
