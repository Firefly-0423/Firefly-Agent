import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getTaskSessionStore } from "./task-session-store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("Main task store lifecycle", () => {
  it("shares initialization across concurrent parent runs without interrupting a live child", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-task-store-lifecycle-"));
    roots.push(root);
    const first = getTaskSessionStore(root);
    const child = first.createAgent({ sessionId: `agent-${"b".repeat(64)}`,
      agent: { id: "fixture-agent", modelProfile: "review", savedModelProfileId: "saved-review" },
      parentConversationId: "parent-1", parentRunId: "run-1", description: "fixture",
      prompt: "public fixture", mode: "work" });
    const second = getTaskSessionStore(path.join(root, "."));
    expect(second).toBe(first);
    expect(second.get(child.id)?.status).toBe("running");
    expect(second.listForParent("parent-1").map(session => session.id)).toEqual([child.id]);
  });
});
