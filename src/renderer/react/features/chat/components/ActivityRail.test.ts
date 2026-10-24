// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActivityRail, DEFAULT_RAIL_PINS } from "./ActivityRail";
import type { ChatPagePanel } from "./ChatPageNavigation";

let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

function render(activePanel: ChatPagePanel | null = null, onTogglePanel = vi.fn(), onOpenSettings = vi.fn()) {
  act(() => root.render(createElement(ActivityRail, { activePanel, onTogglePanel, onOpenSettings })));
  return { onTogglePanel, onOpenSettings };
}
const rail = () => [...host.querySelectorAll<HTMLButtonElement>("[data-rail-item]")].map(button => button.dataset.railItem);
const item = (id: string) => host.querySelector<HTMLButtonElement>(`[data-rail-item="${id}"]`)!;
const openMore = async () => { await act(async () => item("more").click()); };
const menuItem = (id: string) => document.querySelector<HTMLButtonElement>(`[data-rail-menu-item="${id}"]`)!;
const pinOf = (id: string) => menuItem(id).parentElement!.querySelector<HTMLButtonElement>(".ff-activity-rail__menu-pin")!;

it("shows home, the pinned panels and ··· on the rail, with names for screen readers", () => {
  render();
  expect(rail()).toEqual(["home", ...DEFAULT_RAIL_PINS, "more"]);
  expect(item("home").getAttribute("aria-current")).toBe("page");
  expect(item("plugin").getAttribute("aria-label")).toBe("插件");
});

it("opens a panel from the rail and goes home by closing the open one", () => {
  const { onTogglePanel } = render();
  act(() => item("skill").click());
  expect(onTogglePanel).toHaveBeenLastCalledWith("skill");
  const second = render("skill");
  expect(item("skill").getAttribute("aria-current")).toBe("page");
  act(() => item("skill").click());
  expect(second.onTogglePanel).not.toHaveBeenCalled();
  act(() => item("home").click());
  expect(second.onTogglePanel).toHaveBeenCalledExactlyOnceWith("skill");
});

it("lists every panel by name under ··· and opens the chosen one", async () => {
  const { onTogglePanel } = render();
  await openMore();
  expect([...document.querySelectorAll(".ff-activity-rail__menu-open span")].map(node => node.textContent)).toEqual(["插件", "技能", "工具", "模型", "定时任务"]);
  await act(async () => menuItem("scheduled").click());
  expect(onTogglePanel).toHaveBeenCalledExactlyOnceWith("scheduled");
});

it("lights ··· for an open panel that is not pinned", () => {
  render("model");
  expect(item("more").getAttribute("aria-current")).toBe("page");
  expect(item("more").tabIndex).toBe(0);
});

it("pins and unpins panels on the rail and remembers the choice", async () => {
  render();
  await openMore();
  expect(pinOf("tool").getAttribute("aria-pressed")).toBe("true");
  await act(async () => pinOf("model").click());
  await act(async () => pinOf("tool").click());
  expect(rail()).toEqual(["home", "plugin", "skill", "model", "more"]);
  expect(JSON.parse(localStorage.getItem("ff.activityRail.pinned")!)).toEqual(["plugin", "skill", "model"]);
});

it("moves focus along the rail with the arrow keys", () => {
  render();
  act(() => item("home").focus());
  act(() => { item("home").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  expect(document.activeElement).toBe(item("plugin"));
  act(() => { item("plugin").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
  expect(document.activeElement).toBe(item("more"));
});

it("opens the settings from the avatar at the bottom", () => {
  const { onOpenSettings } = render();
  act(() => host.querySelector<HTMLButtonElement>(".ff-activity-rail__user")!.click());
  expect(onOpenSettings).toHaveBeenCalledTimes(1);
  expect(host.querySelector(".ff-activity-rail__user .is-placeholder")?.textContent).toBe("U");
});
