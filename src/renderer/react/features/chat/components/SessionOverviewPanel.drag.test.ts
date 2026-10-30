// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionOverviewPanel, type SessionOverviewPanelProps } from "./SessionOverviewPanel";
import type { WorkspaceRunOutput } from "../workspace/workspace-artifacts";

const DEFAULT = ["environment", "connectors", "tasks", "context", "changes", "outputs", "usage", "memory"];
let host: HTMLDivElement; let root: Root;
function render(props: Partial<SessionOverviewPanelProps> = {}) {
  act(() => root.render(createElement(SessionOverviewPanel, { outputs: [], ...props })));
  // jsdom has no layout: give each card a 100px row, stacked in DOM order.
  for (const card of host.querySelectorAll<HTMLElement>("[data-overview-card]")) {
    card.getBoundingClientRect = () => {
      const index = [...host.querySelectorAll("[data-overview-card]")].indexOf(card);
      return { top: index * 100, height: 100, bottom: index * 100 + 100, left: 0, right: 200, width: 200, x: 0, y: index * 100, toJSON() {} } as DOMRect;
    };
  }
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const order = () => [...host.querySelectorAll<HTMLElement>("[data-overview-card]")].map(card => card.dataset.overviewCard);
const card = (id: string) => host.querySelector<HTMLElement>(`[data-overview-card="${id}"]`)!;
const grip = (id: string) => card(id).querySelector<HTMLButtonElement>("[data-overview-grip]")!;
const head = (id: string) => card(id).querySelector<HTMLButtonElement>(".ff-overview-card__head")!;
const pointer = (target: Element, type: string, clientY: number) =>
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, buttons: 1, clientY })); });
const output = (id: string, files: number, description = ""): WorkspaceRunOutput => ({
  id, sessionId: "s", runId: id, messageId: id, tools: [],
  files: Array.from({ length: files }, (_, index) => ({ toolId: `t${index}`, change: { file: `f${index}.ts`, kind: "modified", insertions: 1, deletions: 0 } })) as WorkspaceRunOutput["files"],
  tasks: description ? [{ invocationId: id, taskId: id, description, nickname: "n", status: "completed" }] as unknown as WorkspaceRunOutput["tasks"] : [],
});

it("lists environment, connectors, tasks, context, changes, outputs, usage and memory, each with a six-dot grip", () => {
  render();
  expect(order()).toEqual(DEFAULT);
  expect(host.querySelectorAll("[data-overview-grip]")).toHaveLength(8);
});

it("makes environment and connectors one-row entries that open the project and the connector settings", () => {
  const openEnvironment = vi.fn(), openConnectors = vi.fn();
  render({ environment: { mode: "code", workspaceName: "Firefly_Agent" }, onOpenEnvironment: openEnvironment, onOpenConnectors: openConnectors });
  expect(card("environment").hasAttribute("data-entry")).toBe(true);
  expect(card("environment").querySelector(".ff-overview-card__fold")).toBeNull();
  expect(head("environment").hasAttribute("aria-expanded")).toBe(false);
  expect(card("environment").querySelector(".ff-overview-card__summary")?.textContent).toBe("Firefly_Agent");
  act(() => head("environment").click());
  act(() => head("connectors").click());
  expect(openEnvironment).toHaveBeenCalledTimes(1);
  expect(openConnectors).toHaveBeenCalledTimes(1);
});

it("says where a chat without a project runs, and disables an entry with nothing to open", () => {
  render({ environment: { mode: "chat" } });
  expect(card("environment").querySelector(".ff-overview-card__summary")?.textContent).toBe("本机 · 聊天");
  expect(head("environment").disabled).toBe(true);
  render({ environment: { mode: "chat", temporary: true } });
  expect(card("environment").querySelector(".ff-overview-card__summary")?.textContent).toBe("临时对话");
});

it("lists the files the session produced, newest first, and opens the chosen one", () => {
  const open = vi.fn();
  const change = (file: string, kind: string) => ({ toolId: file, change: { file, kind, insertions: 1, deletions: 0 } });
  const first = { ...output("r1", 0), files: [change("E:\\proj\\notes.md", "added"), change("E:\\proj\\src\\app.ts", "modified"), change("E:\\proj\\old.txt", "added")] } as WorkspaceRunOutput;
  // The second run touches app.ts again and deletes old.txt: app.ts moves to the top once, old.txt is no longer an output.
  const second = { ...output("r2", 0), files: [change("E:\\proj\\src\\app.ts", "modified"), change("E:\\proj\\old.txt", "deleted")] } as WorkspaceRunOutput;
  render({ outputs: [first, second], workspaceRoot: "E:\\proj", onOpenOutputFile: open });
  expect(card("outputs").querySelector(".ff-overview-card__summary")?.textContent).toBe("2");
  const rows = [...card("outputs").querySelectorAll<HTMLButtonElement>(".ff-overview-list__row")];
  expect(rows.map(row => row.querySelector(".ff-overview-list__name")?.textContent)).toEqual(["app.ts", "notes.md"]);
  expect(rows.map(row => row.dataset.outputKind)).toEqual(["code", "text"]);
  act(() => rows[0]!.click());
  expect(open).toHaveBeenCalledExactlyOnceWith("src/app.ts");
});

it("keeps a produced file outside the project listed but not openable", () => {
  const outside = { ...output("r1", 0), files: [{ toolId: "t", change: { file: "C:\\tmp\\report.csv", kind: "added", insertions: 3, deletions: 0 } }] } as WorkspaceRunOutput;
  render({ outputs: [outside], workspaceRoot: "E:\\proj", onOpenOutputFile: vi.fn() });
  const row = card("outputs").querySelector<HTMLButtonElement>(".ff-overview-list__row")!;
  expect(row.querySelector(".ff-overview-list__name")?.textContent).toBe("report.csv");
  expect(row.disabled).toBe(true);
});

it("puts the new entry cards on top of an order saved before they existed", () => {
  localStorage.setItem("ff.sessionOverview.order", JSON.stringify(["changes", "tasks", "context"]));
  render();
  expect(order()).toEqual(["environment", "connectors", "changes", "tasks", "context", "outputs", "usage", "memory"]);
});

it("ignores a press that moves less than the 4px dead zone", () => {
  render();
  pointer(grip("tasks"), "pointerdown", 250);
  pointer(grip("tasks"), "pointermove", 253);
  expect(host.querySelector("[data-dragging]")).toBeNull();
  pointer(grip("tasks"), "pointerup", 253);
  expect(order()).toEqual(DEFAULT);
});

it("drags a card down past the others, shows where it lands, and remembers the order", () => {
  render();
  pointer(grip("tasks"), "pointerdown", 250);
  pointer(grip("tasks"), "pointermove", 590);
  expect(card("tasks").hasAttribute("data-dragging")).toBe(true);
  // No drop line: the cards below slide up into the gap the lifted card left.
  expect(host.querySelector(".ff-overview-drop-end")).toBeNull();
  expect(["context", "changes", "outputs"].map(id => card(id).style.getPropertyValue("--ff-shift-y"))).toEqual(["-100px", "-100px", "-100px"]);
  expect(card("connectors").style.getPropertyValue("--ff-shift-y")).toBe("");
  pointer(grip("tasks"), "pointerup", 590);
  // The pointer stops over the sixth slot, so the card lands there, ahead of the usage card.
  const moved = ["environment", "connectors", "context", "changes", "outputs", "tasks", "usage", "memory"];
  expect(order()).toEqual(moved);
  expect(JSON.parse(localStorage.getItem("ff.sessionOverview.order")!)).toEqual(moved);
  expect(host.querySelector("[data-dragging]")).toBeNull();
});

it("moves a card with the arrow keys on its grip", () => {
  render();
  act(() => { grip("changes").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
  expect(order()).toEqual(["environment", "connectors", "tasks", "changes", "context", "outputs", "usage", "memory"]);
  act(() => { grip("tasks").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  expect(order()).toEqual(["environment", "connectors", "changes", "tasks", "context", "outputs", "usage", "memory"]);
});

it("folds a card with the grid animation and keeps its body out of reach while closed", () => {
  render();
  expect(card("context").dataset.open).toBe("true");
  act(() => head("context").click());
  expect(card("context").dataset.open).toBe("false");
  const fold = card("context").querySelector<HTMLElement>(".ff-overview-card__fold")!;
  expect(fold.getAttribute("aria-hidden")).toBe("true");
  expect(fold.hasAttribute("inert")).toBe(true);
});

it("lifts the dragged card so it follows the pointer, and Escape puts it back", () => {
  render();
  pointer(grip("tasks"), "pointerdown", 250);
  pointer(grip("tasks"), "pointermove", 330);
  expect(card("tasks").style.getPropertyValue("--ff-drag-y")).toBe("80px");
  act(() => { grip("tasks").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(host.querySelector("[data-dragging]")).toBeNull();
  pointer(grip("tasks"), "pointerup", 330);
  expect(order()).toEqual(DEFAULT);
});

it("drags a whole card by its header, and the release does not also fold it", () => {
  render();
  pointer(head("context"), "pointerdown", 350);
  pointer(head("context"), "pointermove", 110);
  expect(card("context").hasAttribute("data-dragging")).toBe(true);
  expect(card("connectors").style.getPropertyValue("--ff-shift-y")).toBe("100px");
  pointer(head("context"), "pointerup", 110);
  act(() => head("context").click());
  expect(order()).toEqual(["environment", "context", "connectors", "tasks", "changes", "outputs", "usage", "memory"]);
  expect(card("context").dataset.open).toBe("true");
  act(() => head("context").click());
  expect(card("context").dataset.open).toBe("false");
});
