import { describe, expect, it } from "vitest";
import type { ChatSessionMeta, ConversationMode } from "./chat-types";
import {
  compareSidebarCreation,
  orderSidebarSessions,
  sidebarGroupId,
  sidebarProjectSection,
  sidebarSessionGroup,
  SIDEBAR_LAYOUT_IPC,
  SIDEBAR_MODES,
  type ModeSidebarLayout,
  type SidebarSnapshot,
} from "./sidebar-layout";

function session(
  id: string,
  createdAt: number,
  updatedAt: number,
  pinned = false,
): ChatSessionMeta {
  return {
    id,
    title: id,
    identityId: null,
    createdAt,
    updatedAt,
    messageCount: 1,
    mode: "chat",
    ...(pinned ? { pinned: true } : {}),
  };
}

function modeLayout(partial: Partial<ModeSidebarLayout> = {}): ModeSidebarLayout {
  return {
    viewMode: "project",
    sortMode: "recent",
    hiddenProjectIds: [],
    sections: [],
    collapsedGroupIds: [],
    membership: {},
    manualOrders: {},
    groupOrder: [],
    ...partial,
  };
}

function snapshot(
  mode: ConversationMode,
  layout: Partial<ModeSidebarLayout>,
  sessionProjectIds: Record<string, string | null> = {},
): SidebarSnapshot {
  return {
    layout: {
      schemaVersion: 1,
      revision: 1,
      projects: [],
      modes: {
        chat: modeLayout(),
        work: modeLayout(),
        code: modeLayout(),
        [mode]: modeLayout(layout),
      },
    },
    sessionProjectIds,
    notices: [],
  };
}

describe("sidebar group ids", () => {
  it("builds stable ids per mode, project and section", () => {
    expect(sidebarGroupId.default("chat")).toBe("chat:default");
    expect(sidebarGroupId.default("work")).toBe("work:default");
    expect(sidebarGroupId.project("work", "p1")).toBe("work:project:p1");
    expect(sidebarGroupId.section("code", "s1")).toBe("code:section:s1");
    expect(SIDEBAR_MODES).toEqual(["chat", "work", "code"]);
    expect(SIDEBAR_LAYOUT_IPC).toEqual({
      get: "sidebar:layout:get",
      mutate: "sidebar:layout:mutate",
      changed: "sidebar:layout:changed",
    });
  });
});

describe("sidebarProjectSection", () => {
  it("returns the section only when it still exists", () => {
    const layout = modeLayout({
      sections: [{ id: "s1", name: "S1" }],
      projectSections: { p1: "s1", p2: "missing" },
    });
    expect(sidebarProjectSection(layout, "p1")).toBe("s1");
    expect(sidebarProjectSection(layout, "p2")).toBeNull();
    expect(sidebarProjectSection(layout, "unknown")).toBeNull();
    expect(sidebarProjectSection(modeLayout(), "p1")).toBeNull();
  });
});

describe("sidebarSessionGroup", () => {
  it("prefers an explicit section membership over the project binding", () => {
    const snap = snapshot(
      "work",
      {
        sections: [{ id: "s1", name: "S1" }],
        membership: { conv: "s1" },
        viewMode: "project",
      },
      { conv: "p1" },
    );
    expect(sidebarSessionGroup(snap, "work", "conv")).toBe("work:section:s1");
  });

  it("falls back to the project group in project view for work and code", () => {
    const snap = snapshot("work", { viewMode: "project" }, { conv: "p1" });
    expect(sidebarSessionGroup(snap, "work", "conv")).toBe("work:project:p1");
    const code = snapshot("code", { viewMode: "project" }, { conv: "p1" });
    expect(sidebarSessionGroup(code, "code", "conv")).toBe("code:project:p1");
  });

  it("uses the default group in merged view, in chat mode, or without a project", () => {
    expect(sidebarSessionGroup(snapshot("work", { viewMode: "merged" }, { conv: "p1" }), "work", "conv")).toBe("work:default");
    expect(sidebarSessionGroup(snapshot("chat", { viewMode: "project" }, { conv: "p1" }), "chat", "conv")).toBe("chat:default");
    expect(sidebarSessionGroup(snapshot("work", { viewMode: "project" }, { conv: null }), "work", "conv")).toBe("work:default");
    expect(sidebarSessionGroup(snapshot("code", { viewMode: "project" }), "code", "conv")).toBe("code:default");
  });

  it("ignores membership pointing at a deleted section", () => {
    const snap = snapshot("chat", { membership: { conv: "gone" } }, { conv: null });
    expect(sidebarSessionGroup(snap, "chat", "conv")).toBe("chat:default");
  });
});

describe("compareSidebarCreation", () => {
  it("orders by creation time and breaks ties by id", () => {
    expect(compareSidebarCreation(session("a", 1, 9), session("b", 2, 1))).toBeLessThan(0);
    expect(compareSidebarCreation(session("b", 2, 1), session("a", 1, 9))).toBeGreaterThan(0);
    expect(compareSidebarCreation(session("a", 5, 1), session("b", 5, 1))).toBeLessThan(0);
    expect(compareSidebarCreation(session("b", 5, 1), session("a", 5, 1))).toBeGreaterThan(0);
    expect(compareSidebarCreation(session("a", 5, 1), session("a", 5, 1))).toBe(0);
  });
});

describe("orderSidebarSessions", () => {
  it("sorts recent mode by updatedAt descending with id tie-breaks", () => {
    const sessions = [session("b", 1, 10), session("a", 2, 10), session("c", 3, 30)];
    expect(orderSidebarSessions(sessions, modeLayout({ sortMode: "recent" }), "g").map(s => s.id))
      .toEqual(["c", "a", "b"]);
  });

  it("keeps pinned sessions first in both sort modes", () => {
    const sessions = [session("a", 1, 30), session("pinned", 2, 1, true)];
    expect(orderSidebarSessions(sessions, modeLayout({ sortMode: "recent" }), "g").map(s => s.id))
      .toEqual(["pinned", "a"]);
    expect(orderSidebarSessions(sessions, modeLayout({ sortMode: "manual" }), "g").map(s => s.id))
      .toEqual(["pinned", "a"]);
  });

  it("applies manual order and appends unlisted sessions by creation time", () => {
    const sessions = [session("late", 30, 30), session("first", 10, 10), session("second", 20, 20)];
    const layout = modeLayout({ sortMode: "manual", manualOrders: { g: ["second", "first"] } });
    expect(orderSidebarSessions(sessions, layout, "g").map(s => s.id))
      .toEqual(["second", "first", "late"]);
  });

  it("ignores manual ids that are no longer present and does not mutate input", () => {
    const sessions = [session("b", 2, 2), session("a", 1, 1)];
    const copy = [...sessions];
    const layout = modeLayout({ sortMode: "manual", manualOrders: { g: ["gone", "b"] } });
    expect(orderSidebarSessions(sessions, layout, "g").map(s => s.id)).toEqual(["b", "a"]);
    expect(sessions).toEqual(copy);
    expect(sessions).not.toBe(copy);
  });

  it("treats missing manual order for the group as append-only", () => {
    const sessions = [session("b", 2, 2), session("a", 1, 1)];
    expect(orderSidebarSessions(sessions, modeLayout({ sortMode: "manual" }), "other").map(s => s.id))
      .toEqual(["a", "b"]);
  });
});
