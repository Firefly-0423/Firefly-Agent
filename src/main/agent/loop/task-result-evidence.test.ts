import { describe, expect, it } from "vitest";
import { extractTaskResult } from "./task-result-evidence";

const result = { agentId: "reviewer", sessionId: "child-1", status: "completed", text: "Full result " + "x".repeat(300) };
describe("task result presentation evidence", () => {
  it("keeps actual delegate output beyond the 200-character preview", () => {
    expect(extractTaskResult("delegate_agent", JSON.stringify(result))).toEqual(result);
  });
  it("does not treat another tool's JSON as a delegated task", () => {
    expect(extractTaskResult("read_file", JSON.stringify(result))).toBeUndefined();
  });
  it.each([undefined, "bad", "null", "[]", JSON.stringify({ ...result, status: "invented" }), JSON.stringify({ ...result, sessionId: "" }), JSON.stringify({ ...result, text: 1 })])("rejects malformed results: %s", output => {
    expect(extractTaskResult("delegate_agent", output)).toBeUndefined();
  });
  it.each(["failed", "cancelled", "interrupted"])("preserves terminal status %s", status => {
    expect(extractTaskResult("delegate_agent", JSON.stringify({ ...result, status }))).toMatchObject({ status });
  });
  it("bounds display text and marks truncation, omitting extra fields", () => {
    expect(extractTaskResult("delegate_agent", JSON.stringify({ ...result, text: "a".repeat(64001), secretExtra: "discard" }))).toEqual({ ...result, text: "a".repeat(64000), truncated: true });
  });
});

const write = { path: "src/a.ts", canonicalPath: "/synthetic/src/a.ts", agentId: "reviewer", childRunId: "child-run-1", toolCallId: "write-1", state: "applied", before: { sha256: "a".repeat(64) }, after: { version: "absent" }, eventIds: ["write-event-1"] };
const executionEvent = { id: "model-1", seq: 1, monotonicMs: 10, clockDomainId: "synthetic-clock", agentId: "reviewer", parentRunId: "run-1", childRunId: "child-run-1", executionId: "execution-1", phase: "start" };
it("long_result_does_not_truncate_write_ledger", () => {
  const writes = Array.from({ length: 1000 }, (_, index) => ({ ...write, path: `src/${index}.ts`, canonicalPath: `/synthetic/src/${index}.ts` }));
  const actual = extractTaskResult("delegate_agent", JSON.stringify({ ...result, status: "failed", text: "x".repeat(64001), writes, executionEvents: [executionEvent], error: { code: "AGENT_WRITE_CONFLICT", message: "Path already owned" } }));
  expect(actual).toMatchObject({ text: "x".repeat(64000), truncated: true, writes, executionEvents: [executionEvent], error: { code: "AGENT_WRITE_CONFLICT", message: "Path already owned" } });
});
it("keeps all effect states and only whitelisted evidence fields", () => {
  const writes = ["applied", "partially_applied", "unknown", "not_applied"].map(state => ({ ...write, state, secretExtra: "discard" }));
  expect(extractTaskResult("delegate_agent", JSON.stringify({ ...result, writes, executionEvents: [{ ...executionEvent, modelPrompt: "discard" }] }))).toMatchObject({ writes: writes.map(({ secretExtra: _secret, ...evidence }) => evidence), executionEvents: [executionEvent] });
  expect(JSON.stringify(extractTaskResult("delegate_agent", JSON.stringify({ ...result, writes, executionEvents: [{ ...executionEvent, modelPrompt: "discard" }] })))).not.toContain("discard");
});
it.each([
  { writes: "made changes" }, { writes: [{ ...write, state: "success" }] }, { writes: [{ ...write, before: { sha256: "fake-hash" } }] },
  { writes: [{ ...write, eventIds: [1] }] }, { writes: [{ ...write, agentId: "other" }] }, { writes: [{ ...write, after: { version: 3 } }] },
  { executionEvents: [{ ...executionEvent, monotonicMs: -1 }] }, { executionEvents: [{ ...executionEvent, seq: 1.5 }] },
  { executionEvents: [{ ...executionEvent, phase: "terminal", terminal: "success" }] }, { error: { code: "AGENT_WRITE_CONFLICT", message: 3 } },
])("foreign_run_and_malformed_evidence_rejected: %j", fields => {
  expect(extractTaskResult("delegate_agent", JSON.stringify({ ...result, ...fields }))).toBeUndefined();
});

it("rejects foreign parent-run evidence at extraction boundary", () => {
  expect(extractTaskResult("delegate_agent", JSON.stringify({ ...result, executionEvents: [executionEvent] }), "different-run")).toBeUndefined();
});

it("preserves prepared-model end event terminal metadata", () => {
  const endEvent = { ...executionEvent, id: "model-end", seq: 2, monotonicMs: 20, phase: "end", terminal: "completed" };
  expect(extractTaskResult("delegate_agent", JSON.stringify({ ...result, executionEvents: [executionEvent, endEvent] }), "run-1")?.executionEvents).toEqual([executionEvent, endEvent]);
});
it("rejects evidence mixed across child invocations without model events", () => {
  expect(extractTaskResult("delegate_agent", JSON.stringify({ ...result, writes: [write, { ...write, childRunId: "foreign-child" }] }))).toBeUndefined();
});
