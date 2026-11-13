import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskSessionStore } from "./task-session-store";

const roots: string[] = [];
const sessionId = `agent-${"a".repeat(64)}`;
const workspace = path.resolve(os.tmpdir(), "firefly-session-workspace");
const agent = { id: "public-specialist", modelProfile: "review", savedModelProfileId: "saved-review" };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-agent-session-store-"));
  roots.push(root);
  let now = 1000;
  let childRun = 0;
  const store = new TaskSessionStore(root, {
    now: () => now,
    createChildRunId: () => `child-run-${++childRun}`,
  });
  return { root, store, tick: () => { now += 1; } };
}

function create(store: TaskSessionStore) {
  return store.createAgent({
    sessionId, agent, parentConversationId: "conversation-1", parentRunId: "run-1",
    description: "Review a public fixture", prompt: "Read the fixture",
    mode: "code", resolvedWorkspaceRoot: workspace,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Firefly agent session store", () => {
  it("preserves the conservative guard for unavailable legacy arguments across restart", () => {
    const { root, store } = fixture();
    create(store);
    const effect = { id: "effect-legacy", toolCallId: "legacy", toolName: "write_file", fingerprint: "write_file()",
      message: "unknown arguments", argumentsUnavailable: true as const };
    store.checkpoint(sessionId, { uncertainEffects: [effect] });
    expect(new TaskSessionStore(root).get(sessionId)?.uncertainEffects).toEqual([effect]);
  });
  it("persists a private agent session outside chat history", () => {
    const { root, store } = fixture();
    const session = create(store);
    expect(session).toMatchObject({ schemaVersion: 2, id: sessionId, agent,
      status: "running", messages: [{ role: "user", content: "Read the fixture" }] });
    expect(fs.existsSync(path.join(root, "firefly-tasks", "sessions", `${sessionId}.json`))).toBe(true);
    expect(fs.existsSync(path.join(root, "firefly-chats", "sessions", `${sessionId}.json`))).toBe(false);
    expect(store.listForParent("other-conversation")).toEqual([]);
  });

  it("preserves uncertain effects through checkpoint, restart, and authorized resume", () => {
    const { root, store } = fixture();
    create(store);
    const effects = [{ id: "effect-1", toolCallId: "call-1", fingerprint: "hash-1",
      toolName: "write_file", message: "outcome unknown" }];
    store.checkpoint(sessionId, { status: "interrupted", uncertainEffects: effects });
    effects[0].message = "mutated outside store";
    const restarted = new TaskSessionStore(root);
    const resumed = restarted.resumeAgent(sessionId, { agent, parentConversationId: "conversation-1",
      parentRunId: "run-2", prompt: "Continue", mode: "code", resolvedWorkspaceRoot: workspace });
    expect(resumed.uncertainEffects).toEqual([{ ...effects[0], message: "outcome unknown" }]);
    expect(resumed.messages.map(message => message.content)).toEqual(["Read the fixture", "Continue"]);
  });

  it("rejects malformed current session data without rewriting it", () => {
    const { root, store } = fixture();
    create(store);
    const file = path.join(root, "firefly-tasks", "sessions", `${sessionId}.json`);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.uncertainEffects = [{ toolName: "write_file" }];
    const malformed = JSON.stringify(data);
    fs.writeFileSync(file, malformed);
    expect(() => store.get(sessionId)).toThrow("TASK_SESSION_READ_FAILED");
    expect(fs.readFileSync(file, "utf8")).toBe(malformed);
  });

  it("does not load an old task identity as a current agent session", () => {
    const { root, store } = fixture();
    create(store);
    const file = path.join(root, "firefly-tasks", "sessions", `${sessionId}.json`);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.schemaVersion = 1;
    delete data.agent;
    const previous = JSON.stringify(data);
    fs.writeFileSync(file, previous);
    expect(() => store.get(sessionId)).toThrow("TASK_SESSION_READ_FAILED");
    expect(fs.readFileSync(file, "utf8")).toBe(previous);
  });

  it("resumes only the same parent, agent, model, mode, and workspace", () => {
    const { store, tick } = fixture();
    create(store);
    store.checkpoint(sessionId, { status: "completed" });
    tick();
    const base = { agent, parentConversationId: "conversation-1", parentRunId: "run-2",
      prompt: "Continue", mode: "code" as const, resolvedWorkspaceRoot: workspace };
    expect(() => store.resumeAgent(sessionId, { ...base, parentConversationId: "other" })).toThrow("TASK_PARENT_MISMATCH");
    expect(() => store.resumeAgent(sessionId, { ...base, agent: { ...agent, id: "other" } })).toThrow("AGENT_IDENTITY_MISMATCH");
    expect(() => store.resumeAgent(sessionId, { ...base, agent: { ...agent, savedModelProfileId: "other" } })).toThrow("AGENT_MODEL_PROFILE_CHANGED");
    expect(() => store.resumeAgent(sessionId, { ...base, resolvedWorkspaceRoot: path.join(workspace, "other") })).toThrow("AGENT_WORKSPACE_MISMATCH");
    expect(store.resumeAgent(sessionId, base).status).toBe("running");
  });

  it("interrupts a running agent after restart and keeps its Todo notebook isolated", () => {
    const { root, store } = fixture();
    create(store);
    store.checkpoint(sessionId, { todoItems: [{ id: "inspect", content: "Read fixture", status: "in_progress" }] });
    const restarted = new TaskSessionStore(root);
    const session = restarted.get(sessionId);
    expect(session?.status).toBe("interrupted");
    expect(session?.todoItems).toEqual([{ id: "inspect", content: "Read fixture", status: "in_progress" }]);
    session?.todoItems.push({ id: "extra", content: "Not persisted", status: "pending" });
    expect(restarted.get(sessionId)?.todoItems).toHaveLength(1);
  });
});

it("restart_preserves_unknown_write_and_exact_execution_evidence_without_fabricating_legacy_data", () => {
  const { root, store } = fixture();
  create(store);
  const writes = [{ path: "fixture.txt", canonicalPath: path.join(workspace, "fixture.txt"), agentId: agent.id,
    childRunId: "child-run-1", toolCallId: "write-1", state: "unknown" as const, before: { sha256: "a".repeat(64) }, eventIds: ["write-start"] }];
  const executionEvents = [{ id: "event-1", seq: 1, monotonicMs: 2, clockDomainId: "synthetic-clock", agentId: agent.id,
    parentRunId: "run-1", childRunId: "child-run-1", executionId: "request-1", phase: "start" as const }];
  store.checkpoint(sessionId, { writes, executionEvents });
  writes[0].eventIds.push("forged"); executionEvents[0].agentId = "forged";
  const restarted = new TaskSessionStore(root);
  expect(restarted.get(sessionId)).toMatchObject({ status: "interrupted", writes: [{ eventIds: ["write-start"], state: "unknown" }], executionEvents: [{ agentId: agent.id }] });
  const resumed = restarted.resumeAgent(sessionId, { agent, parentConversationId: "conversation-1", parentRunId: "run-2", prompt: "Continue safely", mode: "code", resolvedWorkspaceRoot: workspace });
  expect(resumed.writes?.[0].state).toBe("unknown");
  expect(resumed.executionEvents?.[0].parentRunId).toBe("run-1");
  const file = path.join(root, "firefly-tasks", "sessions", `${sessionId}.json`);
  const legacy = JSON.parse(fs.readFileSync(file, "utf8")); delete legacy.writes; delete legacy.executionEvents;
  fs.writeFileSync(file, JSON.stringify(legacy));
  expect(store.get(sessionId)?.writes).toBeUndefined();
  expect(store.get(sessionId)?.executionEvents).toBeUndefined();
});

it("rejects malformed and foreign task execution evidence without rewriting it", () => {
  const { root, store } = fixture(); create(store);
  const file = path.join(root, "firefly-tasks", "sessions", `${sessionId}.json`);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const invalid of [
    { writes: [{ state: "applied" }] },
    { executionEvents: [{ id: "e", seq: 1, monotonicMs: 1, clockDomainId: "clock", agentId: "foreign", parentRunId: "run", childRunId: "c", executionId: "x", phase: "start" }] },
  ]) {
    const malformed = JSON.stringify({ ...saved, ...invalid }); fs.writeFileSync(file, malformed);
    expect(() => store.get(sessionId)).toThrow("TASK_SESSION_READ_FAILED");
    expect(fs.readFileSync(file, "utf8")).toBe(malformed);
  }
});
