import { expect, it } from "vitest";
import type { ChatSessionMeta } from "../../../../../shared/chat-types";
import { sessionGroup, summarizeProjects } from "./sidebar-project-summary";

it("groups bound sessions by path while keeping unbound sessions separate", () => {
  const session = (id: string, updatedAt: number, workspaceRoot?: string, workspaceDisplayName?: string) =>
    ({ id, updatedAt, workspaceRoot, workspaceDisplayName } as ChatSessionMeta);
  const result = summarizeProjects([
    session("a", 5, "C:/project", "First name"), session("b", 9, "C:/project", "Later name"),
    session("c", 3), session("d", 8),
  ], () => "Unbound");
  expect([...result.keys()]).toEqual(["C:/project", "unbound:c", "unbound:d"]);
  expect(result.get("C:/project")).toEqual({ name: "First name", workspaceRoot: "C:/project", conversationCount: 2, updatedAt: 9 });
  expect(result.get("unbound:c")).toEqual({ name: "Unbound", workspaceRoot: undefined, conversationCount: 1, updatedAt: 3 });
});

it("chooses status, persisted arrangement, then the appropriate fallback group", () => {
  const session = { id: "a", pinned: true, workspaceRoot: "C:/work" } as ChatSessionMeta;
  const groups = new Map([["a", "section"]]);
  expect(sessionGroup(session, { status: "needs-input", groups, projects: true })).toBe("status:needs-input");
  expect(sessionGroup(session, { groups, projects: true })).toBe("section");
  expect(sessionGroup(session, { groups: new Map(), projects: true })).toBe("C:/work");
  expect(sessionGroup(session, { groups: new Map(), projects: false })).toBe("pinned");
});
