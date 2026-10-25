// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SidebarLayoutApi, SidebarSnapshot } from "../../../../../shared/sidebar-layout";
import type { ChatStoreApi } from "../pages/chat-page-bridge";
import { ConversationSidebar } from "./ConversationSidebar";

vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../../components/feedback/FeedbackProvider", () => ({ useFeedback: () => ({ confirm: vi.fn() }) }));
// The real list is an @ant-design/x widget; here it draws every group label and every row label so the row controls are reachable.
vi.mock("@ant-design/x", () => ({
  Conversations: ({ items, groupable, onActiveChange }: any) => createElement("div", null,
    [...new Set(items.map((item: any) => item.group))].map((group: any) => createElement("section", { key: group, "data-group": group },
      createElement("header", null, groupable.label(group)),
      items.filter((item: any) => item.group === group).map((item: any) => createElement("div", {
        key: item.key, className: "row", "data-row": item.key, onClick: () => onActiveChange?.(item.key),
      }, item.label))))),
}));
vi.mock("antd", () => ({
  Input: () => null,
  Menu: () => null,
  // The popover body is drawn inline, so the hover card can be inspected without a pointer.
  Popover: ({ children, content }: any) => createElement("div", null, children, createElement("aside", { className: "popover-body" }, content)),
  Dropdown: ({ children }: any) => createElement("div", null, children),
  // Open dialogs render inline, so the create-project form can be driven like the rest of the sidebar.
  Modal: ({ open, className, children }: any) => open ? createElement("div", { className }, children) : null,
}));

let host: HTMLDivElement, root: ReturnType<typeof createRoot>, snapshot: SidebarSnapshot;
const DAY = 24 * 60 * 60 * 1000;
const sessions = [
  { id: "a", title: "Check harness", mode: "work" as const, createdAt: 1, updatedAt: Date.now() - 6 * DAY, messageCount: 4,
    workspaceRoot: "E:\\Codex\\Firefly_Agent-skills-layout", workspaceDisplayName: "Backend", pinned: false },
  { id: "b", title: "Pinned one", mode: "work" as const, createdAt: 2, updatedAt: Date.now() - 5 * 60 * 1000, messageCount: 1,
    workspaceRoot: "E:\\Codex\\Firefly_Agent-skills-layout", workspaceDisplayName: "Backend", pinned: true },
];
const onSelect = vi.fn();
const onTogglePin = vi.fn();
const onNewProjectTask = vi.fn();
const pickWorkspaceFolder = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state = () => ({ viewMode: "project" as const, sortMode: "recent" as const, hiddenProjectIds: [], sections: [], collapsedGroupIds: [], membership: {}, manualOrders: {}, groupOrder: [] });
  snapshot = { layout: { schemaVersion: 1, revision: 0, projects: [{ id: "p1", workspaceRoot: "E:\\Codex\\Firefly_Agent-skills-layout", displayName: "Backend" }],
    modes: { chat: { ...state(), viewMode: "merged" }, work: state(), code: state() } }, sessionProjectIds: { a: "p1", b: "p1" }, notices: [] };
  const api: SidebarLayoutApi = { get: vi.fn(async () => ({ ok: true, snapshot })), mutate: vi.fn(async () => ({ ok: true, snapshot })), onChanged: () => () => {} };
  window.chatStore = { sidebarLayout: api, pickWorkspaceFolder } as unknown as ChatStoreApi;
  vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.chatStore; vi.unstubAllGlobals(); });

async function render() {
  await act(async () => root.render(createElement(ConversationSidebar, { mode: "work", sessions, listStatus: "ready", onSelect, onOpenProject: vi.fn(),
    onNewProjectTask, onRename: vi.fn(), onDelete: vi.fn(), onTogglePin, onExport: vi.fn() })));
}
const row = (id: string) => host.querySelector<HTMLElement>(`[data-row="${id}"]`)!;
const buttonIn = (id: string, label: string) => row(id).querySelector<HTMLButtonElement>(`.ff-session-actions__button[aria-label="${label}"]`)!;

it("pins an unpinned conversation from its row without selecting it, and unpins a pinned one", async () => {
  await render();
  await act(async () => buttonIn("a", "sidebar.pin").click());
  expect(onTogglePin).toHaveBeenLastCalledWith("a", true);
  await act(async () => buttonIn("b", "sidebar.unpin").click());
  expect(onTogglePin).toHaveBeenLastCalledWith("b", false);
  expect(onSelect).not.toHaveBeenCalled();
});

it("shows a quiet pin mark only on pinned rows", async () => {
  await render();
  expect(row("a").querySelector(".ff-session-label__pinned")).toBeNull();
  expect(row("b").querySelector(".ff-session-label__pinned")).not.toBeNull();
});

it("opens the existing conversation menu next to the row's more button, again without selecting the row", async () => {
  await render();
  expect(host.querySelector(".ff-session-context-menu")).toBeNull();
  const more = row("a").querySelector<HTMLButtonElement>('.ff-session-actions__button[aria-haspopup="menu"]')!;
  more.getBoundingClientRect = () => ({ left: 120, bottom: 40, top: 20, right: 140, width: 20, height: 20, x: 120, y: 20, toJSON() {} }) as DOMRect;
  await act(async () => more.click());
  const menu = host.querySelector<HTMLElement>(".ff-session-context-menu")!;
  expect(menu).not.toBeNull();
  expect(menu.style.left).toBe("120px");
  expect(menu.style.top).toBe("44px");
  expect(onSelect).not.toHaveBeenCalled();
});

it("describes a conversation in its hover card: title, age, project, folder name", async () => {
  await render();
  const card = row("a").querySelector<HTMLElement>(".ff-session-card")!;
  expect(card.querySelector(".ff-session-card__title")!.textContent).toBe("Check harness");
  expect(card.querySelector(".ff-session-card__age")!.textContent).toBe("sidebar.ageDays");
  const lines = [...card.querySelectorAll(".ff-session-card__rows li span")].map(node => node.textContent);
  expect(lines).toEqual(["Backend", "Firefly_Agent-skills-layout"]);
  expect(row("b").querySelector(".ff-session-card__age")!.textContent).toBe("sidebar.ageMinutes");
});

it("puts the project's ··· menu before its new-conversation button", async () => {
  await render();
  const buttons = [...host.querySelectorAll<HTMLElement>(".ff-conversation-project__actions .ff-conversation-project__more")];
  expect(buttons.map(button => button.getAttribute("aria-label"))).toEqual(["sidebar.projectActions", "sidebar.newProjectChat"]);
});

// The create-project dialog is portalled to document.body.
const dialogButton = (selector: string) => document.querySelector<HTMLButtonElement>(`.ff-create-project ${selector}`);
async function chooseFolderAndCreate(name?: string) {
  await vi.waitFor(() => { if (!dialogButton(".ff-create-project__ghost")) throw new Error("create project dialog not open"); });
  await act(async () => dialogButton(".ff-create-project__ghost")!.click());
  if (name !== undefined) {
    const input = document.querySelector<HTMLInputElement>("#ff-create-project-name")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await act(async () => dialogButton(".ff-create-project__submit")!.click());
}

it("adds a project from the projects heading: name it, choose a folder, then start a conversation in it", async () => {
  pickWorkspaceFolder.mockResolvedValue({ ok: true, path: "E:\\new\\folder", displayName: "folder" });
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>(".ff-tier__add")!.click());
  expect(pickWorkspaceFolder).not.toHaveBeenCalled();
  await chooseFolderAndCreate("Trip plans");
  expect(pickWorkspaceFolder).toHaveBeenCalledTimes(1);
  expect(onNewProjectTask).toHaveBeenCalledWith("E:\\new\\folder", "Trip plans");
});

it("does nothing when the folder chooser is cancelled", async () => {
  pickWorkspaceFolder.mockResolvedValue({ ok: false });
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>(".ff-tier__add")!.click());
  await chooseFolderAndCreate();
  expect(dialogButton(".ff-create-project__submit")!.disabled).toBe(true);
  expect(onNewProjectTask).not.toHaveBeenCalled();
});

it("does not repeat the folder name in the hover card when it is the project's own name", async () => {
  const same = { id: "c", title: "Same name", mode: "work" as const, createdAt: 3, updatedAt: Date.now(), messageCount: 2, workspaceRoot: "E:/work/Backend", workspaceDisplayName: "Backend" };
  await act(async () => root.render(createElement(ConversationSidebar, { mode: "work", sessions: [same], listStatus: "ready", onSelect, onOpenProject: vi.fn(),
    onNewProjectTask, onRename: vi.fn(), onDelete: vi.fn(), onTogglePin, onExport: vi.fn() })));
  const lines = [...row("c").querySelectorAll(".ff-session-card__rows li span")].map(node => node.textContent);
  expect(lines).toEqual(["Backend"]);
});

it("keeps an add-project button in the empty state, so the first project can still be added", async () => {
  pickWorkspaceFolder.mockResolvedValue({ ok: true, path: "E:\first", displayName: "first" });
  await act(async () => root.render(createElement(ConversationSidebar, { mode: "work", sessions: [], listStatus: "ready", onSelect, onOpenProject: vi.fn(),
    onNewProjectTask, onRename: vi.fn(), onDelete: vi.fn(), onTogglePin, onExport: vi.fn() })));
  const add = host.querySelector<HTMLButtonElement>(".ff-conversation-sidebar__add")!;
  expect(add).not.toBeNull();
  await act(async () => add.click());
  await chooseFolderAndCreate();
  expect(onNewProjectTask).toHaveBeenCalledWith("E:\first", "first");
});
