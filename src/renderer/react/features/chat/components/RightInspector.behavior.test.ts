// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RightInspector, type InspectorTab } from "./RightInspector";
import { moveId, reconcileOrder } from "./reorder-list";
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener() {}, removeListener() {} });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const tabs: InspectorTab[] = [
  { id: "files", label: "Files", content: React.createElement("p", null, "Tree") },
  { id: "file:a/notes.md", label: "notes.md", title: "a/notes.md", content: React.createElement("textarea", { defaultValue: "saved draft" }) },
  { id: "diff:notes.md", label: "notes.md", title: "Diff · b/notes.md", content: React.createElement("p", null, "Diff") },
];
const header = (id: string) => host.querySelector<HTMLElement>(`[data-inspector-pane="${id}"] .ff-inspector-pane__head`)!;
const keys = (element: Element, key: string) => act(() => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));

const IDS = ["files", "file:a/notes.md", "diff:notes.md"];
const placed = (id: string) => {
  // jsdom does not model the grid shorthands, so read them from the style attribute.
  const css = (host.querySelector(`[data-inspector-pane="${id}"]`) as HTMLElement).getAttribute("style") ?? "";
  return { column: /grid-column:\s*(\d+)/.exec(css)?.[1] ?? "", row: /grid-row:\s*(\d+)/.exec(css)?.[1] ?? "" };
};
const where = () => IDS.map(id => `${placed(id).column}/${placed(id).row}`);
const render = (list: InspectorTab[]) => act(async () => root.render(React.createElement(RightInspector, { tabs: list, activeTabId: "files", onTabChange() {}, onCloseTab() {} })));
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
const altKey = (element: Element, key: string) => act(() => element.dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true })));
const mouse = (element: Element, type: string, x: number, y: number) => act(() => { element.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, buttons: 1, clientX: x, clientY: y })); });

it("lays panels side by side with a separator between each pair", async () => {
  await render(tabs);
  expect(where()).toEqual(["1/1", "3/1", "5/1"]);
  expect(host.querySelectorAll('[role="separator"]')).toHaveLength(2);
});

it("moves a panel with Alt+arrows without re-parenting it", async () => {
  await render(tabs);
  const before = host.querySelector('[data-inspector-pane="files"]');
  altKey(header("files"), "ArrowRight");
  expect(where()).toEqual(["3/1", "1/1", "5/1"]);
  altKey(header("diff:notes.md"), "ArrowLeft");
  expect(where()).toEqual(["5/1", "1/1", "3/1"]);
  // Moving never re-parents a panel, so a browser or an editor draft inside it is not remounted.
  expect(host.querySelector('[data-inspector-pane="files"]')).toBe(before);
});

it("drags a header onto the lower half of another panel to stack it there", async () => {
  await render(tabs);
  const boxes = [rect(0, 0, 100, 200), rect(108, 0, 100, 200), rect(216, 0, 100, 200)];
  IDS.forEach((id, index) => { (host.querySelector(`[data-inspector-pane="${id}"]`) as HTMLElement).getBoundingClientRect = () => boxes[index]!; });
  const before = host.querySelector('[data-inspector-pane="files"]');
  mouse(header("files"), "pointerdown", 20, 10);
  mouse(header("files"), "pointermove", 22, 10);
  expect(host.querySelector("[data-lifted]")).toBeNull();
  mouse(document.body, "pointermove", 158, 150);
  // The whole panel is lifted and follows the pointer; no drop box, no label.
  expect(host.querySelector('[data-inspector-pane="files"]')?.hasAttribute("data-lifted")).toBe(true);
  expect(host.querySelector(".ff-inspector-drop, .ff-inspector-ghost")).toBeNull();
  // The others already sit where they would be if it were dropped now.
  expect(placed("file:a/notes.md")).toEqual({ column: "1", row: "1" });
  expect(placed("files")).toEqual({ column: "1", row: "2" });
  expect(host.querySelector(".ff-right-inspector")?.hasAttribute("data-shielded")).toBe(true);
  mouse(document.body, "pointerup", 158, 150);
  expect(placed("file:a/notes.md")).toEqual({ column: "1", row: "1" });
  expect(placed("files")).toEqual({ column: "1", row: "2" });
  expect(placed("diff:notes.md").column).toBe("3");
  expect(host.querySelector('[data-inspector-pane="files"]')).toBe(before);
  expect(host.querySelector("[data-lifted]")).toBeNull();
});

it("Escape puts a lifted panel back, and a short press never starts a drag", async () => {
  await render(tabs);
  mouse(header("files"), "pointerdown", 20, 10);
  mouse(header("files"), "pointermove", 23, 10);
  expect(host.querySelector("[data-lifted]")).toBeNull();
  mouse(header("files"), "pointermove", 80, 40);
  expect(host.querySelector("[data-lifted]")).not.toBeNull();
  keys(header("files"), "Escape");
  expect(host.querySelector("[data-lifted]")).toBeNull();
  mouse(header("files"), "pointerup", 80, 40);
  expect(where()).toEqual(["1/1", "3/1", "5/1"]);
});

it("widens a column with the arrow keys on its separator and hides the separators while a panel is enlarged", async () => {
  await render(tabs);
  (host.querySelector('[data-inspector-pane="files"]') as HTMLElement).getBoundingClientRect = () => rect(0, 0, 300, 100);
  (host.querySelector('[data-inspector-pane="file:a/notes.md"]') as HTMLElement).getBoundingClientRect = () => rect(308, 0, 300, 100);
  const grid = host.querySelector<HTMLElement>(".ff-inspector-grid")!;
  keys(host.querySelector('[role="separator"]')!, "ArrowRight");
  expect(grid.style.gridTemplateColumns).toContain("316fr");
  expect(grid.style.gridTemplateColumns).toContain("284fr");
  await act(async () => host.querySelector<HTMLButtonElement>('[data-inspector-pane="files"] [aria-pressed]')!.click());
  expect(host.querySelectorAll('[role="separator"]')).toHaveLength(0);
});

it("shows full context for identical filenames and keeps every panel mounted when one is enlarged", async () => {
  function TestInspector() {
    const [active, setActive] = useState("file:a/notes.md");
    return React.createElement(RightInspector, { tabs, activeTabId: active, onTabChange: setActive, onCloseTab() {} });
  }
  await act(async () => root.render(React.createElement(TestInspector)));
  const textarea = host.querySelector("textarea")!;
  expect(host.querySelector('[title="a/notes.md"]')).not.toBeNull();
  expect(host.querySelector('[title="Diff · b/notes.md"]')).not.toBeNull();
  const enlarge = host.querySelector<HTMLButtonElement>('[data-inspector-pane="diff:notes.md"] [aria-pressed]')!;
  await act(async () => enlarge.click());
  expect(enlarge.getAttribute("aria-pressed")).toBe("true");
  expect((host.querySelector('[data-inspector-pane="file:a/notes.md"]') as HTMLElement).hidden).toBe(true);
  expect(host.querySelector("textarea")).toBe(textarea);
  await act(async () => enlarge.click());
  expect((host.querySelector('[data-inspector-pane="file:a/notes.md"]') as HTMLElement).hidden).toBe(false);
});

it("focusing a panel makes it the active one", async () => {
  const change = vi.fn();
  await act(async () => root.render(React.createElement(RightInspector, { tabs, activeTabId: "files", onTabChange: change, onCloseTab() {} })));
  expect(host.querySelector('[data-inspector-pane="files"]')?.hasAttribute("data-active")).toBe(true);
  act(() => header("diff:notes.md").focus());
  expect(change).toHaveBeenCalledWith("diff:notes.md");
});

it("Delete on a header closes that panel and never consumes editor deletion", async () => {
  const close = vi.fn();
  await act(async () => root.render(React.createElement(RightInspector, { tabs, activeTabId: "file:a/notes.md", onTabChange() {}, onCloseTab: close })));
  keys(host.querySelector("textarea")!, "Delete"); expect(close).not.toHaveBeenCalled();
  keys(header("file:a/notes.md"), "Delete"); expect(close).toHaveBeenCalledExactlyOnceWith("file:a/notes.md");
});

it("ignores Delete on nested browser tab headers", async () => {
  const close = vi.fn(), nested = [{ id: "browser", label: "Browser", content: React.createElement("button", { role: "tab", "data-inner-browser-tab": true }, "Tab 1") }, ...tabs];
  await act(async () => root.render(React.createElement(RightInspector, { tabs: nested, activeTabId: "browser", onTabChange() {}, onCloseTab: close })));
  keys(host.querySelector("[data-inner-browser-tab]")!, "Delete");
  expect(close).not.toHaveBeenCalled();
  keys(header("file:a/notes.md"), "Delete");
  expect(close).toHaveBeenCalledExactlyOnceWith("file:a/notes.md");
});

it("closes any panel from its close button, the file tree included", async () => {
  const close = vi.fn();
  await act(async () => root.render(React.createElement(RightInspector, { tabs, activeTabId: "files", onTabChange() {}, onCloseTab: close })));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-inspector-pane="files"] .ff-right-inspector__close')!.click());
  expect(close).toHaveBeenLastCalledWith("files");
  await act(async () => host.querySelector<HTMLButtonElement>('[data-inspector-pane="diff:notes.md"] .ff-right-inspector__close')!.click());
  expect(close).toHaveBeenLastCalledWith("diff:notes.md");
});

it("reorders ids and keeps the saved order for ids still present", () => {
  expect(reconcileOrder(["c", "a", "x"], ["a", "b", "c"])).toEqual(["c", "a", "b"]);
  expect(moveId(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
  expect(moveId(["a", "b", "c"], "c", -3)).toEqual(["c", "a", "b"]);
});

it("puts a handle between stacked panels that resizes their heights with the arrow keys", async () => {
  await render(tabs);
  const boxes = [rect(0, 0, 100, 200), rect(108, 0, 100, 200), rect(216, 0, 100, 200)];
  IDS.forEach((id, index) => { (host.querySelector(`[data-inspector-pane="${id}"]`) as HTMLElement).getBoundingClientRect = () => boxes[index]!; });
  // Stack "files" under the notes panel, then size the pair with the handle between them.
  mouse(header("files"), "pointerdown", 20, 10);
  mouse(document.body, "pointermove", 158, 150);
  mouse(document.body, "pointerup", 158, 150);
  expect(host.querySelectorAll('[role="separator"][aria-orientation="horizontal"]')).toHaveLength(1);
  const handle = host.querySelector<HTMLElement>('[role="separator"][aria-orientation="horizontal"]')!;
  expect(handle).not.toBeNull();
  (host.querySelector('[data-inspector-pane="file:a/notes.md"]') as HTMLElement).getBoundingClientRect = () => rect(0, 0, 300, 300);
  (host.querySelector('[data-inspector-pane="files"]') as HTMLElement).getBoundingClientRect = () => rect(0, 308, 300, 300);
  keys(handle, "ArrowDown");
  const grid = host.querySelector<HTMLElement>(".ff-inspector-grid")!;
  // 316px over 284px of the two 300px panels.
  expect(grid.style.gridTemplateRows).toBe("minmax(0, 0.526667fr) minmax(0, 0.473333fr)");
});

it("draws the blue guide along an outer side of the panel area while a panel would dock there, and hides it after the drop", async () => {
  await render(tabs);
  const boxes = [rect(0, 0, 100, 200), rect(108, 0, 100, 200), rect(216, 0, 100, 200)];
  IDS.forEach((id, index) => { (host.querySelector(`[data-inspector-pane="${id}"]`) as HTMLElement).getBoundingClientRect = () => boxes[index]!; });
  host.querySelector<HTMLElement>(".ff-right-inspector")!.getBoundingClientRect = () => rect(0, 0, 320, 216);
  const guide = host.querySelector<HTMLElement>(".ff-inspector-drop-guide")!;
  expect(guide.hidden).toBe(true);
  mouse(header("files"), "pointerdown", 20, 10);
  // Lower half of the middle panel: it is alone in its column, so stacking under it docks to the bottom side.
  mouse(document.body, "pointermove", 158, 150);
  expect(guide.hidden).toBe(false);
  expect(guide.dataset.edge).toBe("bottom");
  expect(guide.style.height).toBe("2px");
  expect(guide.style.width).toBe("100px");
  expect(guide.style.top).toBe("211px");
  mouse(document.body, "pointerup", 158, 150);
  expect(guide.hidden).toBe(true);
  expect(guide.dataset.edge).toBeUndefined();
});

it("draws a vertical guide along the far left when a panel would become the first column", async () => {
  await render(tabs);
  const boxes = [rect(0, 0, 100, 200), rect(108, 0, 100, 200), rect(216, 0, 100, 200)];
  IDS.forEach((id, index) => { (host.querySelector(`[data-inspector-pane="${id}"]`) as HTMLElement).getBoundingClientRect = () => boxes[index]!; });
  host.querySelector<HTMLElement>(".ff-right-inspector")!.getBoundingClientRect = () => rect(0, 0, 320, 216);
  const guide = host.querySelector<HTMLElement>(".ff-inspector-drop-guide")!;
  mouse(header("diff:notes.md"), "pointerdown", 230, 10);
  // Left edge of the first panel: the lifted panel would be placed before everything else.
  mouse(document.body, "pointermove", 10, 100);
  expect(guide.dataset.edge).toBe("left");
  expect(guide.style.width).toBe("2px");
  expect(guide.style.left).toBe("3px");
  expect(guide.style.height).toBe("210px");
  mouse(document.body, "pointerup", 10, 100);
  expect(guide.hidden).toBe(true);
});

it("keeps the guide away from the seam between two panels, and hidden when a drag has not started or is cancelled", async () => {
  await render(tabs);
  const boxes = [rect(0, 0, 100, 200), rect(108, 0, 100, 200), rect(216, 0, 100, 200)];
  IDS.forEach((id, index) => { (host.querySelector(`[data-inspector-pane="${id}"]`) as HTMLElement).getBoundingClientRect = () => boxes[index]!; });
  host.querySelector<HTMLElement>(".ff-right-inspector")!.getBoundingClientRect = () => rect(0, 0, 320, 216);
  const guide = host.querySelector<HTMLElement>(".ff-inspector-drop-guide")!;
  mouse(header("diff:notes.md"), "pointerdown", 230, 10);
  mouse(header("diff:notes.md"), "pointermove", 233, 10);
  expect(guide.hidden).toBe(true);
  // Left side of the middle panel: that is a seam between two columns, not an outer side.
  mouse(document.body, "pointermove", 120, 100);
  expect(guide.dataset.edge).toBeUndefined();
  expect(guide.hidden).toBe(true);
  keys(header("diff:notes.md"), "Escape");
  expect(guide.hidden).toBe(true);
});
