import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ephemeralConversations } from "../../ephemeral-conversations";
import { HarnessRunStore } from "./run-store";

const roots: string[] = [], marked: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const id of marked.splice(0)) ephemeralConversations.release(id);
});
const request = { provider: "openai", model: "m", contextWindowTokens: 128_000, mode: "chat", promptFingerprint: "p", toolSchemaFingerprint: "t" };
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-run-ephemeral-"));
  roots.push(root);
  const temp = "temp-" + Math.random().toString(36).slice(2);
  ephemeralConversations.mark(temp); marked.push(temp);
  const runsDir = path.join(root, "firefly-runs");
  return { root, temp, store: new HarnessRunStore(root, { now: () => 1_000 }), sessions: path.join(runsDir, "sessions"), index: path.join(runsDir, "index.json") };
}
const dirEntries = (dir: string) => fs.existsSync(dir) ? fs.readdirSync(dir) : [];

describe("HarnessRunStore for a temporary conversation", () => {
  it("runs the whole lifecycle in memory without a session file, event journal or index row on disk", () => {
    const f = setup();
    f.store.create({ conversationId: f.temp, runId: "run-t", messages: [{ role: "user", content: "private question" }], request });
    f.store.checkpoint("run-t", { messages: [{ role: "user", content: "private question" }, { role: "assistant", content: "private answer" }], rounds: 1 });
    f.store.recordTool("run-t", { toolCallId: "c1", toolName: "read_file", sideEffect: "read_only", status: "committed" });
    f.store.recordCompaction("run-t", { status: "started", messageCountBefore: 2 });
    const done = f.store.markTerminal("run-t", "completed");
    expect(done.status).toBe("completed");
    expect(f.store.get("run-t")?.messages).toHaveLength(2);
    expect(f.store.get("run-t")?.toolCalls.map(call => call.toolCallId)).toEqual(["c1"]);
    expect(dirEntries(f.sessions)).toEqual([]);
    const indexText = fs.existsSync(f.index) ? fs.readFileSync(f.index, "utf8") : "";
    expect(indexText).not.toContain("run-t");
    expect(JSON.stringify(dirEntries(f.sessions)) + indexText).not.toContain("private");
  });

  it("finds a running or interrupted temporary run through the in-memory index only", () => {
    const f = setup();
    f.store.create({ conversationId: f.temp, runId: "run-t", messages: [], request });
    expect(f.store.get("run-t")?.status).toBe("running");
    expect(f.store.getLatestInterrupted(f.temp)).toBeNull();
  });

  it("forgets the run on conversation delete and never survives a restart", () => {
    const f = setup();
    f.store.create({ conversationId: f.temp, runId: "run-t", messages: [], request });
    f.store.deleteConversation(f.temp);
    expect(f.store.get("run-t")).toBeNull();
    f.store.create({ conversationId: f.temp, runId: "run-u", messages: [], request });
    const reopened = new HarnessRunStore(f.root, { now: () => 1_000 });
    expect(reopened.get("run-u")).toBeNull();
    expect(reopened.getLatestInterrupted(f.temp)).toBeNull();
  });

  it("leaves ordinary conversations persisted exactly as before", () => {
    const f = setup();
    f.store.create({ conversationId: "ordinary", runId: "run-p", messages: [{ role: "user", content: "keep" }], request });
    f.store.create({ conversationId: f.temp, runId: "run-t", messages: [], request });
    expect(dirEntries(f.sessions).sort()).toEqual(["run-p.events.jsonl", "run-p.json"]);
    const reopened = new HarnessRunStore(f.root, { now: () => 1_000 });
    expect(reopened.get("run-p")?.status).toBe("interrupted");
    expect(reopened.get("run-t")).toBeNull();
  });
});
