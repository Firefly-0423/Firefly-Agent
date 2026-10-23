import { describe, expect, it } from "vitest";
import type { ChatSession } from "../../shared/chat-types";
import { createWorkMarkdownSnapshot } from "./work-markdown-export";

const session: ChatSession = {
  id: "task", title: "private C:\\secret\\file.txt", identityId: null, mode: "work",
  createdAt: 1, updatedAt: 2, schemaVersion: 1,
  messages: [
    { id: "user", role: "user", content: "read private C:\\secret\\file.txt", at: 1 },
    {
      id: "assistant", role: "model", content: "Public conclusion", at: 2,
      runSnapshot: { status: "terminal", terminalStatus: "success", updatedAt: 2, todos: [{ id: "1", content: "secret C:\\secret\\file.txt", status: "completed" }] },
      workReadReport: { status: "partial", files: [{ name: "public.txt", status: "partial", coveredLines: 2, requiredLines: 2, totalLines: 4 }] },
    },
  ],
};

describe("Work Markdown snapshot", () => {
  it("exports the finished display result without private prompt, todo body or paths", () => {
    const markdown = createWorkMarkdownSnapshot(session);
    expect(markdown).toContain("Public conclusion");
    expect(markdown).toContain("partial");
    expect(markdown).toContain("1. completed");
    expect(markdown).not.toContain("C:\\secret");
    expect(markdown).not.toContain("read private");
  });

  it("rejects unfinished runs and non-Work sessions", () => {
    expect(createWorkMarkdownSnapshot({ ...session, mode: "chat" })).toBeNull();
    expect(createWorkMarkdownSnapshot({ ...session, messages: [{ ...session.messages[1], runSnapshot: { status: "running", updatedAt: 3 } }] })).toBeNull();
  });
});
