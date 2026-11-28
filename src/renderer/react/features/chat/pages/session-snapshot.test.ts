import { expect, it } from "vitest";
import type { ChatSession } from "../../../../../shared/chat-types";
import { restoreSessionTodos } from "./session-snapshot";

it("restores the newest persisted todo snapshot unless a live run already owns state", () => {
  const session = { messages: [
    { runSnapshot: { runId: "old", updatedAt: 1, todos: [] } },
    { runSnapshot: { runId: "new", updatedAt: 2, todos: [{ id: "t", content: "check", status: "pending" }] } },
  ] } as unknown as ChatSession;
  const existing = { s: { runId: "live", updatedAt: 3, todos: [] } };
  expect(restoreSessionTodos(existing, "s", session, true)).toBe(existing);
  expect(restoreSessionTodos(existing, "s", session, false).s).toEqual({ runId: "new", updatedAt: 2, todos: [{ id: "t", content: "check", status: "pending" }] });
  expect(restoreSessionTodos({}, "s", session, true).s.runId).toBe("new");
});
