// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SidebarLayoutApi, SidebarSnapshot } from "../../../../../shared/sidebar-layout";
import type { ChatStoreApi } from "../pages/chat-page-bridge";
import { ConversationSidebar } from "./ConversationSidebar";
vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../../components/feedback/FeedbackProvider", () => ({ useFeedback: () => ({ confirm: vi.fn() }) }));
vi.mock("@ant-design/x", () => ({ Conversations: ({ items, groupable }: any) => createElement("div", null, [...new Set(items.map((item: any) => item.group))].map((group: any) => createElement("div", { key: group, "data-group-label": group }, groupable.label(group)))) }));
// The arrangement menu is an antd Dropdown; here it is flattened into plain buttons keyed by menu key, so the test drives the real item handlers.
const flattenMenu = (items: any[] = []): any[] => items.flatMap(item => item?.children ? flattenMenu(item.children) : item?.key
  ? [createElement("button", { key: item.key, type: "button", "data-menu-key": item.key, disabled: item.disabled, onClick: item.onClick }, String(item.key))] : []);
vi.mock("antd", () => ({ Input: () => null, Menu: () => null, Popover: ({ children, content }: any) => createElement("div", null, children, content),
  Dropdown: ({ children, menu }: any) => createElement("div", null, children, flattenMenu(menu.items)),
  Modal: ({ open, children }: any) => open ? createElement("div", null, children) : null }));
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, snapshot: SidebarSnapshot, api: SidebarLayoutApi;
let changed: () => void;
const sessions = [
  { id: "a", title: "A", mode: "work" as const, createdAt: 1, updatedAt: 1, messageCount: 0, workspaceRoot: "E:\\a" },
  { id: "b", title: "B", mode: "work" as const, createdAt: 2, updatedAt: 2, messageCount: 0, workspaceRoot: "E:\\b" },
];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state = () => ({ viewMode: "project" as const, sortMode: "recent" as const, hiddenProjectIds: [], sections: [], collapsedGroupIds: [], membership: {}, manualOrders: {}, groupOrder: [] });
  snapshot = { layout: { schemaVersion: 1, revision: 0, projects: [{ id: "pa", workspaceRoot: "E:\\a", displayName: "Project A" }, { id: "pb", workspaceRoot: "E:\\b", displayName: "Project B" }], modes: { chat: { ...state(), viewMode: "merged" }, work: state(), code: state() } }, sessionProjectIds: { a: "pa", b: "pb" }, notices: [] };
  api = { get: vi.fn(async () => ({ ok: true, snapshot })), mutate: vi.fn(async input => {
    snapshot = structuredClone(snapshot); ++snapshot.layout.revision;
    if (input.patch.kind === "set-sort") snapshot.layout.modes.work.sortMode = input.patch.sortMode;
    return { ok: true, snapshot };
  }), onChanged: callback => { changed = callback; return () => {}; } };
  window.chatStore = { sidebarLayout: api } as ChatStoreApi;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.chatStore; vi.unstubAllGlobals(); });
const newProjectTask = vi.fn();
async function render() {
  await act(async () => root.render(createElement(ConversationSidebar, { mode: "work", sessions, listStatus: "ready", onSelect: vi.fn(), onOpenProject: vi.fn(), onNewProjectTask: newProjectTask, onRename: vi.fn(), onDelete: vi.fn(), onTogglePin: vi.fn(), onExport: vi.fn() })));
}
const labels = () => [...host.querySelectorAll<HTMLElement>("[data-group-label]")].map(node => node.dataset.groupLabel);
const heads = () => [...host.querySelectorAll<HTMLButtonElement>(".ff-tier__toggle")];
const headTitles = () => heads().map(button => button.textContent);
const state = () => snapshot.layout.modes.work;
const mutated = () => (api.mutate as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0].patch);
it("shows 项目 as the one tier when nothing is pinned or filed, with the folders under it", async () => {
  await render();
  expect(headTitles()).toEqual(["sidebar.projectsTitle"]);
  expect(heads()[0].getAttribute("aria-expanded")).toBe("true");
  expect(labels()).toEqual(["work:project:pa", "work:project:pb"]);
  expect(host.querySelectorAll(".ff-conversation-project__caption")).toHaveLength(0);
});
it("puts pinned projects in 置顶 above 项目, and projects filed in a section under that section", async () => {
  state().sections = [{ id: "s1", name: "Research" }];
  state().pinnedProjectIds = ["pa"];
  state().projectSections = { pb: "s1" };
  await render();
  expect(headTitles()).toEqual(["sidebar.pinnedTitle", "Research"]);
  expect(labels()).toEqual(["work:project:pa", "work:project:pb"]);
});
it("keeps an empty section as a tier with a hint instead of dropping it", async () => {
  state().sections = [{ id: "s1", name: "Research" }];
  await render();
  expect(headTitles()).toEqual(["sidebar.projectsTitle", "Research"]);
  expect(host.textContent).toContain("sidebar.emptyTier");
});
it("folds a tier's folders away with its heading and remembers it on this device", async () => {
  await render();
  await act(async () => heads()[0].click());
  expect(labels()).toEqual([]);
  expect(heads()[0].getAttribute("aria-expanded")).toBe("false");
  expect(window.localStorage.getItem("ff.sidebar.closedTiers.work")).toBe('["projects"]');
  await act(async () => heads()[0].click());
  expect(labels()).toEqual(["work:project:pa", "work:project:pb"]);
  window.localStorage.removeItem("ff.sidebar.closedTiers.work");
});
it("folds a section tier through the saved layout", async () => {
  state().sections = [{ id: "s1", name: "Research" }];
  state().projectSections = { pb: "s1" };
  await render();
  await act(async () => heads()[1].click());
  expect(mutated()).toContainEqual({ mode: "work", kind: "set-expanded", groupId: "work:section:s1", expanded: false });
});
it("gives each project folder a menu to pin, rename, file in a section, open or hide it", async () => {
  state().sections = [{ id: "s1", name: "Research" }];
  await render();
  const menu = (key: string) => host.querySelector<HTMLButtonElement>(`[data-group-label="work:project:pa"] [data-menu-key="${key}"]`)!;
  expect(["pin", "rename", "section:", "section:s1", "open", "hide"].every(key => menu(key) !== null)).toBe(true);
  await act(async () => menu("pin").click());
  await act(async () => menu("section:s1").click());
  await act(async () => menu("hide").click());
  expect(mutated()).toEqual(expect.arrayContaining([
    { mode: "work", kind: "pin-project", projectId: "pa", pinned: true },
    { mode: "work", kind: "move-project", projectId: "pa", sectionId: "s1" },
    { mode: "work", kind: "set-project-visible", projectId: "pa", visible: false },
  ]));
});
it("starts a new conversation inside a project from the pen on its row", async () => {
  await render();
  const pen = host.querySelector<HTMLButtonElement>('[data-group-label="work:project:pb"] button[aria-label="sidebar.newProjectChat"]')!;
  await act(async () => pen.click());
  expect(newProjectTask).toHaveBeenCalledWith("E:\\b", "Project B");
});
