// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SidebarLayoutApi, SidebarSnapshot } from "../../../../../shared/sidebar-layout";
import type { ChatStoreApi } from "../pages/chat-page-bridge";
import { ConversationSidebar } from "./ConversationSidebar";
vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../../components/feedback/FeedbackProvider", () => ({ useFeedback: () => ({ confirm: vi.fn() }) }));
vi.mock("@ant-design/x", () => ({ Conversations: ({ items }: any) => createElement("div", null, items.map((item: any) => createElement("button", { key: item.key, "data-session-id": item.key, "data-group": item.group }, item.label))) }));
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
async function render() {
  await act(async () => root.render(createElement(ConversationSidebar, { mode: "work", sessions, listStatus: "ready", onSelect: vi.fn(), onOpenProject: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onTogglePin: vi.fn(), onExport: vi.fn() })));
}
it("projects server-owned hidden projects and refreshes restored visibility", async () => {
  snapshot.layout.modes.work.hiddenProjectIds = ["pa"];
  await render();
  expect(host.querySelector('[data-session-id="a"]')).toBeNull();
  expect(host.querySelector('[data-session-id="b"]')?.getAttribute("data-group")).toBe("work:project:pb");
  snapshot = structuredClone(snapshot); ++snapshot.layout.revision; snapshot.layout.modes.work.hiddenProjectIds = [];
  await act(async () => changed());
  expect(host.querySelector('[data-session-id="a"]')).not.toBeNull();
});
it("writes sort intent using the latest server revision", async () => {
  await render();
  const manual = host.querySelector<HTMLButtonElement>('[data-menu-key="sort:manual"]');
  expect(manual).not.toBeNull();
  await act(async () => manual!.click());
  expect(api.mutate).toHaveBeenCalledWith({ expectedRevision: 0, patch: { kind: "set-sort", mode: "work", sortMode: "manual" } });
  expect(snapshot.layout.modes.work.sortMode).toBe("manual");
  expect(host.querySelector('[data-menu-key="sort:recent"]')).not.toBeNull();
});
it("creates a section from the groups dialog with the latest server revision", async () => {
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>('[data-menu-key="new-section"]')!.click());
  const form = host.querySelector<HTMLFormElement>(".ff-sidebar-groups__add")!;
  const input = form.querySelector<HTMLInputElement>("input")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Sprint"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(api.mutate).toHaveBeenCalledWith({ expectedRevision: 0, patch: { kind: "create-section", mode: "work", name: "Sprint" } });
  expect(host.querySelector('[data-menu-key="manage"]')).not.toBeNull();
});
