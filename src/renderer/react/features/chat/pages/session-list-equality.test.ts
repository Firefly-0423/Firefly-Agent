import { expect, it } from "vitest";
import type { ChatSessionMeta } from "../../../../../shared/chat-types";
import { sameSessionList } from "./session-list-equality";

it("compares list order and every field used by the sidebar", () => {
  const row = { id: "a", title: "A", identityId: null, createdAt: 1, updatedAt: 2, messageCount: 1,
    purpose: "chat", mode: "chat", workspaceRoot: "C:/a", workspaceDisplayName: "A", pinned: false } as ChatSessionMeta;
  expect(sameSessionList([row], [{ ...row }])).toBe(true);
  for (const key of ["id", "title", "identityId", "createdAt", "updatedAt", "messageCount", "purpose", "mode", "workspaceRoot", "workspaceDisplayName", "pinned"] as const) {
    expect(sameSessionList([row], [{ ...row, [key]: Symbol(key) } as unknown as ChatSessionMeta])).toBe(false);
  }
  expect(sameSessionList([row], [])).toBe(false);
  expect(sameSessionList([row, { ...row, id: "b" }], [{ ...row, id: "b" }, row])).toBe(false);
});
