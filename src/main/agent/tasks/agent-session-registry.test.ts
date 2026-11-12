import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskSessionStore } from "./task-session-store";
import { AgentSessionRegistry } from "./agent-session-registry";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-agent-session-"));
  roots.push(root);
  const store = new TaskSessionStore(root);
  const registry = new AgentSessionRegistry(store);
  return { root, store, registry };
}
const request = {
  parentConversationId: "conversation-1", parentRunId: "run-1", mode: "code" as const,
  resolvedWorkspaceRoot: path.resolve(os.tmpdir(), "public-agent-workspace"),
  agentId: "test-review", modelProfile: "review", savedModelProfileId: "saved-test-profile",
  description: "Review synthetic files", prompt: "Read the public fixture",
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentSessionRegistry", () => {
  it.each([false, true])("retries an acquisition after index failure without a stuck run or duplicate prompt (resume=%s)", (resume) => {
    const { root, store, registry } = fixture();
    if (resume) {
      const first = registry.acquire(request);
      store.checkpoint(first.id, { status: "completed" });
    }
    const rename = fs.renameSync.bind(fs);
    const failure = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (String(destination) === path.join(root, "firefly-tasks", "index.json")) throw new Error("fixture index write failure");
      rename(source, destination);
    });
    expect(() => registry.acquire({ ...request, prompt: "retryable prompt" })).toThrow("fixture index write failure");
    failure.mockRestore();
    const acquired = registry.acquire({ ...request, prompt: "retryable prompt" });
    expect(acquired.messages.filter(message => message.content === "retryable prompt")).toHaveLength(1);
    expect(acquired.messages).toHaveLength(resume ? 2 : 1);
  });

  it("creates an agent-owned session and resumes it by conversation, workspace and agent without task_id", () => {
    const { store, registry } = fixture();
    const first = registry.acquire(request);
    expect(first.schemaVersion).toBe(2);
    expect(first.agent).toEqual({ id: request.agentId, modelProfile: request.modelProfile, savedModelProfileId: request.savedModelProfileId });
    store.checkpoint(first.id, { status: "completed", messages: [...first.messages, { role: "assistant", content: "reviewed" }] });
    const next = registry.acquire({ ...request, parentRunId: "run-2", prompt: "Continue the review" });
    expect(next.id).toBe(first.id);
    expect(next.childRunId).not.toBe(first.childRunId);
    expect(next.messages.map(message => message.content)).toEqual(["Read the public fixture", "reviewed", "Continue the review"]);
  });

  it("isolates agents, conversations and workspaces", () => {
    const { registry } = fixture();
    const sessions = [
      registry.acquire(request),
      registry.acquire({ ...request, agentId: "test-research" }),
      registry.acquire({ ...request, parentConversationId: "conversation-2" }),
      registry.acquire({ ...request, resolvedWorkspaceRoot: path.join(request.resolvedWorkspaceRoot, "other") }),
    ];
    expect(new Set(sessions.map(session => session.id)).size).toBe(4);
  });

  it("rejects concurrent resume, changed routing and changed mode without mutating the transcript", () => {
    const { store, registry } = fixture();
    const first = registry.acquire(request);
    expect(() => registry.acquire(request)).toThrow("TASK_ALREADY_RUNNING");
    store.checkpoint(first.id, { status: "completed" });
    const before = store.get(first.id);
    expect(() => registry.acquire({ ...request, savedModelProfileId: "different-profile" })).toThrow("AGENT_MODEL_PROFILE_CHANGED");
    expect(() => registry.acquire({ ...request, mode: "work" })).toThrow("AGENT_MODE_MISMATCH");
    expect(store.get(first.id)).toEqual(before);
  });

  it("recovers interrupted agent sessions after restart without creating duplicate records", () => {
    const { root, registry } = fixture();
    const first = registry.acquire(request);
    const restartedStore = new TaskSessionStore(root);
    expect(restartedStore.get(first.id)?.status).toBe("interrupted");
    const resumed = new AgentSessionRegistry(restartedStore).acquire({ ...request, parentRunId: "run-2" });
    expect(resumed.id).toBe(first.id);
    expect(restartedStore.listForParent(request.parentConversationId)).toHaveLength(1);
  });

  it("rejects missing routing and non-absolute workspace before any record is created", () => {
    const { store, registry } = fixture();
    expect(() => registry.acquire({ ...request, savedModelProfileId: "" })).toThrow("AGENT_MODEL_PROFILE_REQUIRED");
    expect(() => registry.acquire({ ...request, resolvedWorkspaceRoot: "relative-workspace" })).toThrow("AGENT_WORKSPACE_REQUIRED");
    expect(store.listForParent(request.parentConversationId)).toEqual([]);
  });

  it.each(["running", "completed"] as const)("recovers a %s record when a previous index write was interrupted", (status) => {
    const { root, store, registry } = fixture();
    const first = registry.acquire(request);
    store.checkpoint(first.id, { status });
    fs.writeFileSync(path.join(root, "firefly-tasks", "index.json"), "[]");
    const restarted = new TaskSessionStore(root);
    const resumed = new AgentSessionRegistry(restarted).acquire({ ...request, parentRunId: "run-2" });
    expect(resumed.id).toBe(first.id);
    expect(fs.readdirSync(path.join(root, "firefly-tasks", "sessions"))).toEqual([`${first.id}.json`]);
    expect(restarted.listForParent(request.parentConversationId)).toHaveLength(1);
  });
});
