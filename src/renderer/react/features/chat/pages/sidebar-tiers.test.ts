import { describe, expect, it } from "vitest";
import type { ChatSessionMeta, ConversationMode } from "../../../../../shared/chat-types";
import type { ModeSidebarLayout, SidebarSnapshot } from "../../../../../shared/sidebar-layout";
import { projectTiers } from "./sidebar-tiers";

const session = (id: string, updatedAt = 1, pinned = false, mode: ConversationMode = "work"): ChatSessionMeta => ({ id, title: id, identityId: null, mode, createdAt: 1, updatedAt, messageCount: 0, pinned });
const modeState = (mode: ConversationMode): ModeSidebarLayout => ({ viewMode: mode === "chat" ? "merged" : "project", sortMode: "recent", hiddenProjectIds: [], sections: [{ id: "s1", name: "Research" }], collapsedGroupIds: [], membership: {}, manualOrders: {}, groupOrder: [], pinnedProjectIds: [], projectSections: {} });
const snapshot = (): SidebarSnapshot => ({
  layout: { schemaVersion: 1, revision: 0, projects: [{ id: "p1", workspaceRoot: "/one", displayName: "One" }, { id: "p2", workspaceRoot: "/two", displayName: "Two" }, { id: "p3", workspaceRoot: "/three", displayName: "Three" }], modes: { chat: modeState("chat"), work: modeState("work"), code: modeState("code") } },
  sessionProjectIds: { a: "p1", b: "p2", c: null, d: "p1", e: "p3", f: null }, notices: [],
});
const sessions = [session("a", 5), session("b", 4), session("c", 3), session("d", 9), session("e", 2), session("f", 1)];
const shape = (value: ReturnType<typeof projectTiers>) => value.map(tier => ({ id: tier.id, folders: tier.folders.map(folder => folder.projectId), flat: tier.flatSessionIds }));

describe("project tiers", () => {
  it("lists projects, then sections, then conversations without a project", () => {
    const state = snapshot();
    state.layout.modes.work.sections = [];
    expect(shape(projectTiers(sessions, state, "work"))).toEqual([
      { id: "projects", folders: ["p1", "p2", "p3"], flat: [] },
      { id: "recent", folders: [], flat: ["c", "f"] },
    ]);
  });
  it("lifts pinned projects and pinned conversations without a project into 置顶, and files projects under sections", () => {
    const state = snapshot();
    state.layout.modes.work.pinnedProjectIds = ["p2"];
    state.layout.modes.work.projectSections = { p3: "s1" };
    const value = projectTiers([...sessions.slice(0, 5), session("f", 1, true)], state, "work");
    expect(shape(value)).toEqual([
      { id: "pinned", folders: ["p2"], flat: ["f"] },
      { id: "projects", folders: ["p1"], flat: [] },
      { id: "section:s1", folders: ["p3"], flat: [] },
      { id: "recent", folders: [], flat: ["c"] },
    ]);
  });
  it("never takes a conversation out of its project: pins stay at the top of their own folder", () => {
    const state = snapshot();
    state.layout.modes.work.sections = [];
    const value = projectTiers([session("a", 1, true), session("d", 9)], state, "work");
    expect(value[0].folders[0].sessionIds).toEqual(["a", "d"]);
    expect(value.flatMap(tier => tier.flatSessionIds)).toEqual([]);
  });
  it("hides the plain 项目 tier once every project is filed in a section, but keeps empty section tiers", () => {
    const state = snapshot();
    state.layout.modes.work.sections = [{ id: "s1", name: "Research" }, { id: "s2", name: "Later" }];
    state.layout.modes.work.projectSections = { p1: "s1", p2: "s1", p3: "s1" };
    expect(shape(projectTiers(sessions, state, "work")).map(tier => tier.id)).toEqual(["section:s1", "section:s2", "recent"]);
  });
  it("leaves out hidden projects and other modes, lists each conversation once, and follows the stored folder order", () => {
    const state = snapshot();
    state.layout.modes.work.sections = [];
    state.layout.modes.work.hiddenProjectIds = ["p1"];
    state.layout.modes.work.groupOrder = ["work:project:p3", "work:project:p2"];
    const value = projectTiers([...sessions, session("a", 5), session("x", 1, false, "code")], state, "work");
    expect(value[0].folders.map(folder => folder.projectId)).toEqual(["p3", "p2"]);
    const all = value.flatMap(tier => [...tier.folders.flatMap(folder => folder.sessionIds), ...tier.flatSessionIds]);
    expect(all.sort()).toEqual(["b", "c", "e", "f"]);
  });
});
