import { describe, expect, it } from "vitest";
import type { ChatSessionMeta, ConversationMode } from "../../../../../shared/chat-types";
import type { ModeSidebarLayout, SidebarSnapshot } from "../../../../../shared/sidebar-layout";
import { projectSidebar as project } from "./sidebar-projection";

const session = (id: string, updatedAt = 1, pinned = false, mode: ConversationMode = "work"): ChatSessionMeta => ({ id, title: id, identityId: null, mode, createdAt: 1, updatedAt, messageCount: 0, pinned });
const modeState = (mode: ConversationMode): ModeSidebarLayout => ({ viewMode: mode === "chat" ? "merged" : "project", sortMode: "recent", hiddenProjectIds: [], sections: [{ id: "s1", name: "Research" }], collapsedGroupIds: [], membership: {}, manualOrders: {}, groupOrder: [] });
const snapshot = (): SidebarSnapshot => ({
  layout: { schemaVersion: 1, revision: 0, projects: [{ id: "p1", workspaceRoot: "/one", displayName: "Same" }, { id: "p2", workspaceRoot: "/two", displayName: "Same" }], modes: { chat: modeState("chat"), work: modeState("work"), code: modeState("code") } },
  sessionProjectIds: { a: "p1", b: "p2", c: null, d: "p1" }, notices: [],
});
const ids = (value: ReturnType<typeof project>) => value.groups.flatMap(group => group.sessionIds);
describe("pure sidebar projection", () => {
  it("renders same-name projects separately and unbound sessions exactly once", () => {
    const value = project([session("a"), session("b"), session("c"), session("d"), session("a")], snapshot(), "work");
    expect(value.groups.map(group => group.groupId)).toEqual(["work:project:p1", "work:project:p2", "work:default", "work:section:s1"]);
    expect(ids(value)).toEqual(["a", "d", "b", "c"]);
    expect(new Set(ids(value)).size).toBe(ids(value).length);
  });
  it.each(["project", "merged"] as const)("hidden project filtering precedes custom membership in %s view", viewMode => {
    const state = snapshot();
    state.layout.modes.work.viewMode = viewMode;
    state.layout.modes.work.hiddenProjectIds = ["p1"];
    state.layout.modes.work.membership = { a: "s1", b: "s1" };
    expect(ids(project([session("a", 99, true), session("b"), session("c"), session("d")], state, "work"))).toEqual(["c", "b"]);
  });
  it("keeps pins inside their unique custom/project groups with deterministic recent ordering", () => {
    const state = snapshot();
    state.layout.modes.work.membership = { b: "s1", c: "s1" };
    state.sessionProjectIds.e = "p1";
    const value = project([session("d", 30), session("a", 2, true), session("e", 30), session("b", 1, true), session("c", 90)], state, "work");
    expect(value.groups.find(group => group.projectId === "p1")!.sessionIds).toEqual(["a", "d", "e"]);
    expect(value.groups.find(group => group.sectionId === "s1")!.sessionIds).toEqual(["b", "c"]);
    expect(new Set(ids(value)).size).toBe(5);
  });
  it("manual order survives timestamp changes and appends new IDs while retaining local pin lanes", () => {
    const state = snapshot();
    state.layout.modes.work.viewMode = "merged";
    state.layout.modes.work.sortMode = "manual";
    state.layout.modes.work.manualOrders["work:default"] = ["b", "a", "c"];
    const value = project([session("d", 999), session("c", 500), session("a", 1), session("b", 2, true), session("new", 900)], state, "work");
    expect(ids(value)).toEqual(["b", "a", "c", "d", "new"]);
    expect(ids(project([session("new", 1), session("d", 1), session("c", 1), session("a", 9999), session("b", 1, true)], state, "work"))).toEqual(ids(value));
  });
  it("returns deleted-section members to their default location without duplicates", () => {
    const state = snapshot();
    state.layout.modes.work.sections = [];
    state.layout.modes.work.membership = { a: "s1", b: "s1" };
    expect(ids(project([session("a"), session("b"), session("c")], state, "work"))).toEqual(["a", "b", "c"]);
  });
  it("Chat stays flat and isolated from workspace grouping; collapse does not lose sessions", () => {
    const state = snapshot();
    state.layout.modes.chat.collapsedGroupIds = ["chat:default"];
    const value = project([session("a", 1, false, "chat"), session("b", 2, true, "chat"), session("c")], state, "chat");
    expect(value.groups.every(group => group.projectId === undefined)).toBe(true);
    expect(ids(value)).toEqual(["b", "a"]);
  });
  it("applies explicit group order and does not mutate either input", () => {
    const state = snapshot();
    state.layout.modes.work.groupOrder = ["work:section:s1", "work:default", "work:project:p2", "work:project:p1"];
    const sessions = [session("a"), session("b"), session("c")];
    const before = JSON.stringify({ state, sessions });
    const value = project(sessions, state, "work");
    expect(value.groups.map(group => group.groupId)).toEqual(state.layout.modes.work.groupOrder);
    expect(JSON.stringify({ state, sessions })).toBe(before);
  });
});
