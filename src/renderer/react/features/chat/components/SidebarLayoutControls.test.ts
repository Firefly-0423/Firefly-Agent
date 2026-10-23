// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { SidebarLayoutApi, SidebarSnapshot } from "../../../../../shared/sidebar-layout";
import { mergeGroupOrder, SidebarLayoutControls } from "./SidebarLayoutControls";
import { useSidebarLayout } from "../pages/use-sidebar-layout";
vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, snapshot: SidebarSnapshot, api: SidebarLayoutApi;
const sessions = [] as const;
type Group = { groupId: string; label: string; sectionId?: string; projectId?: string; sessionIds: string[] };
const groups: Group[] = [{ groupId: "work:section:s", sectionId: "s", label: "Section", sessionIds: [] }, { groupId: "work:default", label: "Recent", sessionIds: [] }];
const groupOrder = ["work:project:pb", "work:section:s", "work:project:pa", "work:default"];
function Harness({ groups: list = groups, projectIds = [] }: { groups?: Group[]; projectIds?: string[] }) {
  const layout = useSidebarLayout(api, sessions);
  return layout.snapshot && createElement(SidebarLayoutControls, { mode: "work", snapshot: layout.snapshot, groups: list, projectIds, title: "Section title", pending: layout.pending, mutate: layout.mutate });
}
const render = (props: { groups?: Group[]; projectIds?: string[] } = {}) => act(async () => root.render(createElement(Harness, props)));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const state = { viewMode: "merged" as const, sortMode: "recent" as const, hiddenProjectIds: [], sections: [{ id: "s", name: "Section" }], collapsedGroupIds: [], membership: {}, manualOrders: {}, groupOrder: [...groupOrder] };
  snapshot = { layout: { schemaVersion: 1, revision: 3, projects: [], modes: { work: state, chat: state, code: state } }, sessionProjectIds: {}, notices: [] };
  api = { get: vi.fn(async () => ({ ok: true, snapshot })), mutate: vi.fn(async () => ({ ok: false, code: "storage_error" })), onChanged: () => () => {} };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.querySelectorAll(".ant-modal-root, .ant-dropdown").forEach(node => node.remove()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const menuOpen = () => document.querySelector(".ff-sidebar-menu:not(.ant-dropdown-hidden)") !== null;
async function openMenu() {
  if (menuOpen()) return;
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="sidebar.manageLayout"]')!.click());
  await flush();
}
const menuTitles = () => Array.from(document.querySelectorAll(".ff-sidebar-menu .ant-dropdown-menu-item, .ff-sidebar-menu .ant-dropdown-menu-submenu-title"), node => node.textContent ?? "");
const findItem = (text: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(node => node.textContent?.includes(text));
async function clickMenu(text: string) {
  await vi.waitFor(() => { if (!findItem(text)) throw new Error(`menu item not found: ${text}; have ${menuTitles().join(" | ")}`); });
  await act(async () => findItem(text)!.click());
  await flush();
}

// Dialog helpers: the dialog is portalled to document.body, so queries go through document.
const dialog = () => document.querySelector<HTMLElement>(".ff-sidebar-groups");
const mainRows = () => Array.from(document.querySelectorAll<HTMLLIElement>(".ff-sidebar-groups > .ff-sidebar-groups__list > li"));
const projectRowEls = () => Array.from(document.querySelectorAll<HTMLLIElement>(".ff-sidebar-groups__projects > .ff-sidebar-groups__list > li"));
const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
async function openDialog() {
  await openMenu();
  await clickMenu("sidebar.manageSections");
  await vi.waitFor(() => { if (!dialog()) throw new Error("dialog not open"); });
}
/** jsdom never finishes antd's exit motion, so closing is observed as the leave class rather than DOM removal. */
async function closeDialog() {
  await act(async () => document.querySelector<HTMLButtonElement>(".ant-modal-close")!.click());
  await vi.waitFor(() => { if (!document.querySelector(".ff-sidebar-groups-modal")?.classList.contains("ant-zoom-leave")) throw new Error("dialog still open"); });
}
const setValue = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const key = (target: EventTarget, init: KeyboardEventInit) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
const pointer = (type: string, target: EventTarget, clientX: number, clientY: number) => act(() => {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY }));
});
/** jsdom has no layout: give each row a 40px box so the drag can find the row under the pointer. */
function stubRowBoxes(rows: HTMLElement[]) {
  rows.forEach((row, index) => vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ x: 0, y: index * 40, top: index * 40, bottom: index * 40 + 40, left: 0, right: 200, width: 200, height: 40, toJSON: () => ({}) } as DOMRect));
}

it("removes the inline management panel and keeps the heading to one toggle button", async () => {
  await render();
  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="sidebar.manageLayout"]')!;
  expect(toggle.getAttribute("aria-haspopup")).toBe("menu");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector(".ff-sidebar-layout__panel")).toBeNull();
  expect(host.querySelector("form")).toBeNull();
  await openMenu();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(menuTitles().join("|")).toMatch(/sidebar\.groupBy.*sidebar\.sortBy.*sidebar\.show.*sidebar\.newSection.*sidebar\.manageSections.*sidebar\.resetDefaults/);
  expect(host.querySelector(".ff-conversation-sidebar__title")?.textContent).toBe("Section title");
});
it("opens the groups dialog from the menu, lists the groups in order, and closes it", async () => {
  await render();
  await openDialog();
  expect(mainRows().map(row => row.textContent)).toEqual(["Section", "sidebar.recentTitle"]);
  await closeDialog();
});
it("focuses the add input when opened from New section", async () => {
  await render();
  await openMenu();
  await clickMenu("sidebar.newSection");
  await vi.waitFor(() => { if (document.activeElement !== document.querySelector(".ff-sidebar-groups__add input")) throw new Error("add input not focused"); });
});
it("adds a section from the dialog and keeps the draft when the write is rejected", async () => {
  vi.mocked(api.mutate).mockResolvedValueOnce({ ok: false, code: "conflict" });
  await render();
  await openDialog();
  const input = document.querySelector<HTMLInputElement>(".ff-sidebar-groups__add input")!;
  setValue(input, "Keep this draft");
  await act(async () => document.querySelector<HTMLFormElement>(".ff-sidebar-groups__add")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(api.mutate).toHaveBeenCalledWith({ expectedRevision: 3, patch: { mode: "work", kind: "create-section", name: "Keep this draft" } });
  expect(input.value).toBe("Keep this draft");
});
it("clears the add input once the section is created", async () => {
  vi.mocked(api.mutate).mockResolvedValueOnce({ ok: true, snapshot });
  await render();
  await openDialog();
  const input = document.querySelector<HTMLInputElement>(".ff-sidebar-groups__add input")!;
  setValue(input, "Sprint");
  await act(async () => document.querySelector<HTMLFormElement>(".ff-sidebar-groups__add")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(input.value).toBe(""));
  expect(api.mutate).toHaveBeenCalledWith({ expectedRevision: 3, patch: { mode: "work", kind: "create-section", name: "Sprint" } });
});
it("renames a section inline: Enter saves the new name", async () => {
  await render();
  await openDialog();
  await act(async () => document.querySelector<HTMLButtonElement>(".ff-sidebar-groups__name")!.click());
  const input = document.querySelector<HTMLInputElement>('input[aria-label="sidebar.renameSection"]')!;
  expect(input.value).toBe("Section");
  setValue(input, "Renamed");
  await key(input, { key: "Enter" });
  expect(api.mutate).toHaveBeenCalledWith({ expectedRevision: 3, patch: { mode: "work", kind: "rename-section", sectionId: "s", name: "Renamed" } });
  expect(document.querySelector('input[aria-label="sidebar.renameSection"]')).toBeNull();
});
it("renames a section from the pencil and Escape cancels without writing", async () => {
  await render();
  await openDialog();
  await act(async () => byLabel("sidebar.renameSection")!.click());
  const input = document.querySelector<HTMLInputElement>('input[aria-label="sidebar.renameSection"]')!;
  setValue(input, "Discard me");
  await key(input, { key: "Escape" });
  expect(document.querySelector('input[aria-label="sidebar.renameSection"]')).toBeNull();
  expect(dialog()).not.toBeNull(); // Escape stays inside the rename field and does not close the dialog
  expect(api.mutate).not.toHaveBeenCalled();
});
it("deletes a section only after the inline confirm", async () => {
  await render();
  await openDialog();
  await act(async () => byLabel("sidebar.deleteSection")!.click());
  expect(api.mutate).not.toHaveBeenCalled();
  await act(async () => document.querySelector<HTMLButtonElement>(".ff-sidebar-groups__text.is-danger")!.click());
  expect(api.mutate).toHaveBeenCalledWith({ expectedRevision: 3, patch: { mode: "work", kind: "delete-section", sectionId: "s" } });
});
it("toggles project visibility from the project group and the visibility list", async () => {
  snapshot.layout.projects = [{ id: "pa", workspaceRoot: "E:\\a", displayName: "Project A" }, { id: "pb", workspaceRoot: "E:\\b", displayName: "Project B" }];
  const projectGroups: Group[] = [{ groupId: "work:project:pa", label: "Project A", projectId: "pa", sessionIds: [] }, ...groups];
  await render({ groups: projectGroups, projectIds: ["pa", "pb"] });
  await openDialog();
  expect(mainRows().map(row => row.textContent)).toEqual(["Project A", "Section", "sidebar.recentTitle"]);
  expect(projectRowEls().map(row => row.textContent)).toEqual(["Project B"]);
  await act(async () => mainRows()[0].querySelector<HTMLButtonElement>('button[aria-label="sidebar.hideProject"]')!.click());
  expect(api.mutate).toHaveBeenLastCalledWith({ expectedRevision: 3, patch: { mode: "work", kind: "set-project-visible", projectId: "pa", visible: false } });
  await act(async () => projectRowEls()[0].querySelector<HTMLButtonElement>('button[aria-label="sidebar.hideProject"]')!.click());
  expect(api.mutate).toHaveBeenLastCalledWith({ expectedRevision: 3, patch: { mode: "work", kind: "set-project-visible", projectId: "pb", visible: false } });
});
it("shows a hidden project from the visibility list", async () => {
  snapshot.layout.projects = [{ id: "pb", workspaceRoot: "E:\\b", displayName: "Project B" }];
  snapshot.layout.modes.work.hiddenProjectIds = ["pb"];
  await render({ projectIds: ["pb"] });
  await openDialog();
  const show = projectRowEls()[0].querySelector<HTMLButtonElement>('button[aria-label="sidebar.showProject"]')!;
  await act(async () => show.click());
  expect(api.mutate).toHaveBeenCalledWith({ expectedRevision: 3, patch: { mode: "work", kind: "set-project-visible", projectId: "pb", visible: true } });
});
it("reorders by pointer drag after a 4px dead zone and writes the new visible order", async () => {
  await render();
  await openDialog();
  const rows = mainRows();
  stubRowBoxes(rows);
  const handle = rows[0].querySelector<HTMLElement>(".ff-sidebar-groups__handle")!;
  await pointer("pointerdown", handle, 10, 20);
  await pointer("pointermove", window, 10, 22); // inside the dead zone: still a click
  expect(rows[0].classList.contains("is-dragging")).toBe(false);
  await pointer("pointermove", window, 10, 60);
  expect(rows[0].classList.contains("is-dragging")).toBe(true);
  expect(rows[1].classList.contains("is-drop-after")).toBe(true);
  await pointer("pointerup", window, 10, 60);
  expect(api.mutate).toHaveBeenCalledWith({ expectedRevision: 3, patch: { mode: "work", kind: "set-group-order", groupIds: ["work:project:pb", "work:default", "work:project:pa", "work:section:s"] } });
  expect(mainRows()[0].classList.contains("is-dragging")).toBe(false);
});
it("ignores a pointer move that lands on the dragged row's own slot", async () => {
  await render();
  await openDialog();
  const rows = mainRows();
  stubRowBoxes(rows);
  await pointer("pointerdown", rows[0].querySelector<HTMLElement>(".ff-sidebar-groups__handle")!, 10, 20);
  await pointer("pointermove", window, 10, 30);
  expect(rows[0].classList.contains("is-dragging")).toBe(true);
  expect(rows.some(row => row.classList.contains("is-drop-before") || row.classList.contains("is-drop-after"))).toBe(false);
  await pointer("pointerup", window, 10, 30);
  expect(api.mutate).not.toHaveBeenCalled();
});
it("moves the focused row with Alt+ArrowDown and keeps focus on it", async () => {
  await render();
  await openDialog();
  const first = mainRows()[0];
  first.focus();
  await key(first, { key: "ArrowDown" }); // plain arrows do nothing
  expect(api.mutate).not.toHaveBeenCalled();
  vi.mocked(api.mutate).mockResolvedValueOnce({ ok: true, snapshot });
  await key(first, { key: "ArrowDown", altKey: true });
  expect(api.mutate).toHaveBeenCalledWith({ expectedRevision: 3, patch: { mode: "work", kind: "set-group-order", groupIds: ["work:project:pb", "work:default", "work:project:pa", "work:section:s"] } });
  // The server answers with the new order; the list re-renders and focus follows the moved section.
  await render({ groups: [groups[1], groups[0]] });
  await vi.waitFor(() => expect(document.activeElement).toBe(mainRows()[1]));
  expect(mainRows()[1].textContent).toBe("Section");
});
it("does not reorder with Alt+Arrow while the focused element is a rename field", async () => {
  await render();
  await openDialog();
  await act(async () => document.querySelector<HTMLButtonElement>(".ff-sidebar-groups__name")!.click());
  const input = document.querySelector<HTMLInputElement>('input[aria-label="sidebar.renameSection"]')!;
  await key(input, { key: "ArrowDown", altKey: true });
  expect(api.mutate).not.toHaveBeenCalled();
});
it("disables reorder, rename and delete controls while a write is pending", async () => {
  vi.mocked(api.mutate).mockReturnValue(new Promise(() => {})); // never settles: the queue stays pending
  await render();
  await openDialog();
  await key(mainRows()[0], { key: "ArrowDown", altKey: true });
  await vi.waitFor(() => expect(byLabel("sidebar.deleteSection")!.hasAttribute("disabled")).toBe(true));
  expect(byLabel("sidebar.renameSection")!.hasAttribute("disabled")).toBe(true);
  expect(document.querySelector<HTMLButtonElement>(".ff-sidebar-groups__add button")!.disabled).toBe(true);
});
it("sorts and groups through submenus, patching only what changed", async () => {
  await render();
  await openMenu();
  await clickMenu("sidebar.sortBy");
  await clickMenu("sidebar.manualSort");
  expect(api.mutate).toHaveBeenCalledWith({ expectedRevision: 3, patch: { mode: "work", kind: "set-sort", sortMode: "manual" } });
  vi.mocked(api.mutate).mockClear();
  await openMenu();
  await clickMenu("sidebar.groupBy");
  await clickMenu("sidebar.viewMergedShort");
  expect(api.mutate).not.toHaveBeenCalled(); // already merged in this fixture
  await openMenu();
  await clickMenu("sidebar.groupBy");
  await clickMenu("sidebar.viewProjectsShort");
  expect(api.mutate).toHaveBeenCalledWith({ expectedRevision: 3, patch: { mode: "work", kind: "set-view", viewMode: "project" } });
});
it("greys out reset while everything is at its default", async () => {
  snapshot.layout.modes.work = { ...snapshot.layout.modes.work, viewMode: "project" };
  await render();
  await openMenu();
  expect(findItem("sidebar.resetDefaults")!.getAttribute("aria-disabled")).toBe("true");
  expect(findItem("sidebar.viewAll")!.getAttribute("aria-disabled")).toBe("true");
});
it("resets a changed view and sort one patch at a time, stopping when one is rejected", async () => {
  snapshot.layout.modes.work = { ...snapshot.layout.modes.work, viewMode: "merged", sortMode: "manual" };
  vi.mocked(api.mutate).mockResolvedValue({ ok: false, code: "conflict" });
  await render();
  await openMenu();
  expect(findItem("sidebar.resetDefaults")!.getAttribute("aria-disabled")).not.toBe("true");
  await clickMenu("sidebar.resetDefaults");
  expect(api.mutate).toHaveBeenCalledTimes(1);
  expect(api.mutate).toHaveBeenCalledWith({ expectedRevision: 3, patch: { mode: "work", kind: "set-view", viewMode: "project" } });
});
it("leaves out project-only entries in Chat mode", async () => {
  function ChatHarness() {
    const layout = useSidebarLayout(api, sessions);
    return layout.snapshot && createElement(SidebarLayoutControls, { mode: "chat", snapshot: layout.snapshot, groups: [], projectIds: [], title: "T", pending: layout.pending, mutate: layout.mutate });
  }
  await act(async () => root.render(createElement(ChatHarness)));
  await openMenu();
  expect(menuTitles().join("|")).not.toContain("sidebar.groupBy");
  expect(menuTitles().join("|")).not.toContain("sidebar.show");
  expect(menuTitles().join("|")).toContain("sidebar.sortBy");
});

it("keeps hidden groups in their slots when the visible groups are reordered", () => {
  // pb and pa are hidden project groups: they keep slots 0 and 2 while the visible section and Recent swap.
  expect(mergeGroupOrder(groupOrder, ["work:default", "work:section:s"])).toEqual(["work:project:pb", "work:default", "work:project:pa", "work:section:s"]);
});
it("appends visible groups that have no stored slot after the stored order", () => {
  expect(mergeGroupOrder(["x"], ["n1", "n2"])).toEqual(["x", "n1", "n2"]);
  expect(mergeGroupOrder(["a", "hidden", "b", "c"], ["c", "a", "b"])).toEqual(["c", "hidden", "a", "b"]);
});
