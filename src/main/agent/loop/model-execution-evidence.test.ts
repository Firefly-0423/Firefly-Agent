import { expect, it } from "vitest";
import { createModelExecutionRecorder } from "./model-execution-evidence";
import type { ModelExecutionEvent } from "../../../shared/agent-execution-evidence";

it("records one shared monotonic sequence with detached Main identities", () => {
  let now = 5;
  const events: ModelExecutionEvent[] = [];
  const recorder = createModelExecutionRecorder({ domainId: "synthetic-clock", now: () => now++ }, event => events.push(event));
  const identity = { agentId: "A", parentRunId: "parent", childRunId: "child-A", executionId: "request-A" };
  const a = recorder.observe(identity), b = recorder.observe({ ...identity, agentId: "B", childRunId: "child-B", executionId: "request-B" });
  identity.agentId = "forged-late-change";
  a("start"); b("start"); a("end", "completed"); b("end", "failed");
  expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4]);
  expect(events.map(event => event.monotonicMs)).toEqual([5, 6, 7, 8]);
  expect(new Set(events.map(event => event.id)).size).toBe(4);
  expect(events.every(event => event.clockDomainId === "synthetic-clock")).toBe(true);
  expect(events.map(event => [event.agentId, event.phase, event.terminal])).toEqual([
    ["A", "start", undefined], ["B", "start", undefined], ["A", "end", "completed"], ["B", "end", "failed"],
  ]);
});

it("ignores duplicate or unstarted phases and cannot affect dispatch when observers fail", async () => {
  const events: ModelExecutionEvent[] = [];
  const recorder = createModelExecutionRecorder({ domainId: "clock", now: () => 1 }, event => {
    events.push(event); throw Error("observer rejected");
  });
  const observe = recorder.observe({ agentId: "A", parentRunId: "P", childRunId: "C", executionId: "E" });
  expect(() => { observe("end", "failed"); observe("start"); observe("start"); observe("end", "cancelled"); observe("end", "completed"); }).not.toThrow();
  expect(events.map(event => event.phase)).toEqual(["start", "end"]);
  expect(events[1].terminal).toBe("cancelled");
  const asynchronous = createModelExecutionRecorder({ domainId: "clock", now: () => 1 }, async () => { throw Error("async observer failure"); });
  asynchronous.observe({ agentId: "B", parentRunId: "P", childRunId: "D", executionId: "F" })("start");
  await Promise.resolve();
});

it("shares the recorder with isolated nonthrowing child subscriptions", () => {
  const recorder = createModelExecutionRecorder({ domainId: "clock", now: () => 1 }, () => undefined);
  const events: ModelExecutionEvent[] = [];
  const unsubscribe = recorder.subscribe(event => { if (event.childRunId === "C") events.push(event); });
  recorder.subscribe(() => { throw Error("bad child checkpoint"); });
  const observe = recorder.observe({ agentId: "A", parentRunId: "P", childRunId: "C", executionId: "E" });
  observe("start"); unsubscribe(); observe("end", "completed");
  expect(events.map(event => event.phase)).toEqual(["start"]);
});
