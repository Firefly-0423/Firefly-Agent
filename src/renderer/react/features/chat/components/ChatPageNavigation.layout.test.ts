// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../../i18n";
import type { ChatPageNavigationProps } from "./ChatPageNavigation";

vi.mock("./AppUpdateEntry", () => ({ AppUpdateEntry: () => null }));
vi.mock("../../../components/ui/UserAvatar", () => ({ UserAvatar: () => null }));
vi.mock("./ConversationSidebar", () => ({ ConversationSidebar: () => React.createElement("div", null, "legacy-session-fixture") }));
import { ChatPageNavigation } from "./ChatPageNavigation";

let root: Root;
let host: HTMLDivElement;
const props: ChatPageNavigationProps = {
  collapsed: false, activePanel: null, mode: "chat", sessions: [], sessionListStatus: "ready",
  onToggleCollapsed: vi.fn(), onModeChange: vi.fn(), onNewTask: vi.fn(), onTogglePanel: vi.fn(),
  onSelectSession: vi.fn(), onOpenProject: vi.fn(), onRenameSession: vi.fn(), onDeleteSession: vi.fn(),
  onTogglePinSession: vi.fn(), onExportSession: vi.fn(), onMinimize: vi.fn(), onMaximize: vi.fn(),
  onCloseWindow: vi.fn(), onOpenSettings: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn() });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); delete (window as unknown as { user?: unknown }).user; });
function render(changes: Partial<ChatPageNavigationProps> = {}) {
  act(() => root.render(React.createElement(ChatPageNavigation, { ...props, ...changes })));
}
function button(label: string) {
  const node = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!node) throw new Error(`Missing button: ${label}`);
  return node;
}
describe("workspace navigation layout", () => {
  it("temporarily reveals hidden context on hover without pinning, and retracts when entering chat", () => {
    render({ collapsed: true });
    const rail = host.querySelector<HTMLElement>(".ff-page-edge")!;
    const aside = host.querySelector<HTMLElement>(".ff-page-sidebar")!;
    act(() => rail.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    expect(aside.hasAttribute("inert")).toBe(false);
    expect(aside.classList.contains("is-peeking")).toBe(true);
    expect(aside.classList.contains("is-floating")).toBe(true);
    expect(props.onToggleCollapsed).not.toHaveBeenCalled();
    act(() => rail.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: aside })));
    act(() => aside.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: rail })));
    expect(aside.hasAttribute("inert")).toBe(false);
    act(() => aside.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
    expect(aside.hasAttribute("inert")).toBe(true);
    expect(props.onToggleCollapsed).not.toHaveBeenCalled();
  });
  it("keeps the activity rail usable outside the folded sidebar", () => {
    render({ collapsed: true });
    const rail = host.querySelector<HTMLElement>(".ff-activity-rail")!;
    const aside = host.querySelector<HTMLElement>(".ff-page-sidebar")!;
    expect(aside.hasAttribute("inert")).toBe(true);
    expect(aside.contains(rail)).toBe(false);
    act(() => rail.querySelector<HTMLButtonElement>('[data-rail-item="skill"]')!.click());
    expect(props.onTogglePanel).toHaveBeenCalledExactlyOnceWith("skill");
  });

  it("keeps the floating sidebar open while crossing its owned hover corridor", () => {
    render({ collapsed: true });
    const rail = host.querySelector<HTMLElement>(".ff-page-edge")!;
    const aside = host.querySelector<HTMLElement>(".ff-page-sidebar")!;
    act(() => rail.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    const corridor = aside.querySelector<HTMLElement>(".ff-sidebar-hover-corridor");
    expect(corridor).not.toBeNull();
    act(() => rail.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: corridor })));
    act(() => corridor!.dispatchEvent(new MouseEvent("pointermove", { bubbles: true })));
    expect(aside.hasAttribute("inert")).toBe(false);
    act(() => corridor!.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: aside })));
    act(() => aside.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: corridor })));
    expect(aside.classList.contains("is-peeking")).toBe(true);
    act(() => aside.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
    expect(aside.hasAttribute("inert")).toBe(true);
    expect(props.onToggleCollapsed).not.toHaveBeenCalled();
  });
  it("allows a narrow floating sidebar to resize without reserving a second chat column", () => {
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    render({ collapsed: true });
    const rail = host.querySelector<HTMLElement>(".ff-page-edge")!;
    act(() => rail.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    const handle = host.querySelector<HTMLElement>('[role="separator"]')!;
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
    expect(handle.getAttribute("aria-valuemax")).toBe("360");
    act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(handle.getAttribute("aria-valuenow")).toBe("256");
    expect(localStorage.getItem("firefly.chat.sidebar-width")).toBe("256");
  });
  it("does not let a second pointer replace a live resize and releases capture on cancel", () => {
    render();
    const handle = host.querySelector<HTMLElement>('[role="separator"]')!;
    const pointer = (type: string, x: number, id: number) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { pointerId: id, clientX: x, button: 0 });
    const capture = vi.fn(), release = vi.fn();
    Object.assign(handle, { setPointerCapture: capture, releasePointerCapture: release, hasPointerCapture: () => true });
    act(() => handle.dispatchEvent(pointer("pointerdown", 240, 1)));
    act(() => handle.dispatchEvent(pointer("pointerdown", 260, 2)));
    act(() => window.dispatchEvent(pointer("pointermove", 280, 1)));
    expect(handle.getAttribute("aria-valuenow")).toBe("280");
    expect(capture).toHaveBeenCalledExactlyOnceWith(1);
    act(() => window.dispatchEvent(pointer("pointercancel", 280, 2)));
    expect(handle.classList.contains("is-resizing")).toBe(true);
    act(() => window.dispatchEvent(pointer("pointercancel", 280, 1)));
    expect(handle.classList.contains("is-resizing")).toBe(false);
    expect(release).toHaveBeenCalledExactlyOnceWith(1);
    act(() => window.dispatchEvent(pointer("pointermove", 330, 1)));
    expect(handle.getAttribute("aria-valuenow")).toBe("280");
    act(() => handle.dispatchEvent(pointer("pointerdown", 280, 3)));
    act(() => window.dispatchEvent(new Event("blur")));
    expect(handle.classList.contains("is-resizing")).toBe(false);
  });
  it("ends a resize when pointer capture is lost and keeps the last width", () => {
    render();
    const handle = host.querySelector<HTMLElement>('[role="separator"]')!;
    const pointer = (type: string, x: number) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { pointerId: 7, clientX: x, button: 0 });
    act(() => handle.dispatchEvent(pointer("pointerdown", 240)));
    act(() => window.dispatchEvent(pointer("pointermove", 260)));
    act(() => handle.dispatchEvent(pointer("lostpointercapture", 260)));
    expect(handle.classList.contains("is-resizing")).toBe(false);
    act(() => window.dispatchEvent(pointer("pointermove", 320)));
    expect(handle.getAttribute("aria-valuenow")).toBe("260");
  });
  it("places the resize handle inside an expanded narrow overlay", () => {
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    render();
    const aside = host.querySelector<HTMLElement>(".ff-page-sidebar")!;
    const handle = aside.querySelector<HTMLElement>('[role="separator"]')!;
    expect(handle).not.toBeNull();
    act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(aside.style.width).toBe("256px");
  });
  it("resizes a hover overlay without pinning it or hiding during the drag", () => {
    render({ collapsed: true });
    const rail = host.querySelector<HTMLElement>(".ff-page-edge")!;
    const aside = host.querySelector<HTMLElement>(".ff-page-sidebar")!;
    act(() => rail.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    const handle = host.querySelector<HTMLElement>('[role="separator"]');
    expect(handle).not.toBeNull();
    const pointer = (type: string, x: number) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { pointerId: 7, clientX: x, button: 0 });
    act(() => handle!.dispatchEvent(pointer("pointerdown", 240)));
    act(() => aside.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
    act(() => document.body.dispatchEvent(pointer("pointermove", 280)));
    expect(aside.hasAttribute("inert")).toBe(false);
    expect(aside.style.width).toBe("280px");
    expect(props.onToggleCollapsed).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(pointer("pointerup", 280)));
    expect(aside.hasAttribute("inert")).toBe(true);
    expect(localStorage.getItem("firefly.chat.sidebar-width")).toBe("280");
  });
  it("holds the floating context while a control inside owns keyboard focus and releases after focus leaves", () => {
    render({ collapsed: true });
    const rail = host.querySelector<HTMLElement>(".ff-page-edge")!;
    const aside = host.querySelector<HTMLElement>(".ff-page-sidebar")!;
    act(() => rail.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); button(t("sidebar.searchAction")).focus(); });
    act(() => rail.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
    expect(aside.hasAttribute("inert")).toBe(false);
    const outside = document.createElement("button"); document.body.appendChild(outside);
    act(() => outside.focus());
    expect(aside.hasAttribute("inert")).toBe(true);
    outside.remove();
  });
  it("retracts after a pointer-focused control, while keeping keyboard focus visible", () => {
    render({ collapsed: true });
    const rail = host.querySelector<HTMLElement>(".ff-page-edge")!, aside = host.querySelector<HTMLElement>(".ff-page-sidebar")!;
    act(() => rail.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    const control = aside.querySelector<HTMLButtonElement>("button")!;
    act(() => { control.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); control.focus(); });
    act(() => rail.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
    expect(aside.hasAttribute("inert")).toBe(true);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    act(() => { button(t("ui.toggleSidebar")).focus(); control.focus(); });
    expect(aside.hasAttribute("inert")).toBe(false);
  });
  it("toggles pinned visibility with Ctrl+Shift+S and exposes the shortcut", () => {
    render({ collapsed: true });
    expect(button(t("ui.toggleSidebar")).title).toContain("Ctrl+Shift+S");
    const event = new KeyboardEvent("keydown", { key: "S", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(props.onToggleCollapsed).toHaveBeenCalledOnce();
    render();
    act(() => host.querySelector(".ff-page-sidebar")!.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
    expect(host.querySelector(".ff-page-sidebar")?.hasAttribute("inert")).toBe(false);
  });
  it("clears pointer drag feedback on release without stealing keyboard focus", () => {
    render();
    const handle = host.querySelector<HTMLElement>('[role="separator"]')!;
    const previous = button(t("ui.toggleSidebar")); act(() => previous.focus());
    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.assign(down, { pointerId: 7, clientX: 240, button: 0 });
    act(() => handle.dispatchEvent(down));
    expect(handle.classList.contains("is-resizing")).toBe(true);
    expect(document.activeElement).toBe(previous);
    const up = new Event("pointerup"); Object.assign(up, { pointerId: 7 });
    act(() => window.dispatchEvent(up));
    expect(handle.classList.contains("is-resizing")).toBe(false);
  });
  it("exposes a bounded keyboard resize handle and restores its width after collapse", () => {
    localStorage.clear();
    render();
    const handle = host.querySelector<HTMLElement>('[role="separator"][aria-orientation="vertical"]')!;
    expect(handle).toBeTruthy();
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
    act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(handle.getAttribute("aria-valuenow")).toBe("256");
    render({ collapsed: true });
    expect(host.querySelector('[role="separator"]')).toBeNull();
    render();
    expect(host.querySelector('[role="separator"]')?.getAttribute("aria-valuenow")).toBe("256");
    expect(host.querySelector<HTMLElement>(".ff-page-sidebar")!.style.width).toBe("256px");
  });
  it("clamps pointer resizing, persists user width, and restores it after a narrow viewport", () => {
    render();
    const handle = host.querySelector<HTMLElement>('[role="separator"]')!;
    const pointer = (type: string, x: number, id = 1) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { clientX: x, pointerId: id, button: 0 });
      return event;
    };
    act(() => handle.dispatchEvent(pointer("pointerdown", 240)));
    act(() => window.dispatchEvent(pointer("pointermove", 600, 2)));
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
    act(() => window.dispatchEvent(pointer("pointermove", 600)));
    act(() => window.dispatchEvent(pointer("pointerup", 600)));
    expect(handle.getAttribute("aria-valuenow")).toBe("360");
    expect(localStorage.getItem("firefly.chat.sidebar-width")).toBe("360");
    Object.defineProperty(window, "innerWidth", { value: 960, configurable: true });
    act(() => window.dispatchEvent(new Event("resize")));
    expect(handle.getAttribute("aria-valuenow")).toBe("250");
    expect(localStorage.getItem("firefly.chat.sidebar-width")).toBe("360");
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    act(() => window.dispatchEvent(new Event("resize")));
    expect(handle.getAttribute("aria-valuenow")).toBe("360");
    act(() => handle.dispatchEvent(pointer("pointerdown", 360)));
    act(() => window.dispatchEvent(pointer("pointermove", 0)));
    act(() => window.dispatchEvent(pointer("pointercancel", 0)));
    expect(handle.getAttribute("aria-valuenow")).toBe("180");
    act(() => window.dispatchEvent(pointer("pointermove", 600)));
    expect(handle.getAttribute("aria-valuenow")).toBe("180");
  });
  it("keeps resize usable when optional layout storage throws", () => {
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    render();
    const handle = host.querySelector<HTMLElement>('[role="separator"]')!;
    act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(handle.getAttribute("aria-valuenow")).toBe("224");
    read.mockRestore(); write.mockRestore();
  });
  it("marks only the generated portrait as the white U placeholder", () => {
    render();
    const avatar = host.querySelector(".ff-activity-rail__user .ff-user-avatar-circle")!;
    expect(avatar.classList.contains("is-placeholder")).toBe(true);
    expect(avatar.textContent).toBe("U");
  });
  it("keeps the generated U portrait when a nickname exists without an uploaded avatar", async () => {
    Object.assign(window, { user: {
      getAvatar: async () => null, onAvatarChanged: () => () => {},
      getProfile: async () => ({ nickname: "Synthetic nickname" }), onProfileChanged: () => () => {},
    } });
    await act(async () => render());
    expect(host.querySelector(".ff-activity-rail__user .is-placeholder")?.textContent).toBe("U");
    expect(button(t("ui.userMenu")).getAttribute("aria-description")).toBe("Synthetic nickname");
  });
  it("keeps mounted history inert while collapsed and reaches settings from the rail avatar", () => {
    render({ collapsed: true });
    const aside = host.querySelector<HTMLElement>(".ff-page-sidebar")!;
    expect(aside.hasAttribute("inert")).toBe(true);
    expect(host.textContent).toContain("legacy-session-fixture");
    expect(host.querySelector(".ff-page-titlebar")?.hasAttribute("inert")).toBe(false);
    expect(button(t("ui.toggleSidebar")).getAttribute("aria-expanded")).toBe("false");
    act(() => button(t("ui.userMenu")).click());
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
  });
  it("keeps the Firefly portrait visible outside the collapsed context", () => {
    render({ collapsed: true });
    const portrait = host.querySelector<HTMLImageElement>(".ff-page-titlebar img.ff-page-role-avatar")!;
    expect(portrait).toBeTruthy();
    expect(portrait.src).toMatch(/\/avatars\/firefly-avatar\.png$/);
    expect(host.querySelector(".ff-page-sidebar")?.contains(portrait)).toBe(false);
  });
  it("refreshes the local portrait and nickname through the existing profile events", async () => {
    let changedAvatar: (() => void) | undefined;
    let changedProfile: ((profile: { nickname: string }) => void) | undefined;
    let avatar = "data:image/png;base64,fixture-one";
    Object.assign(window, { user: {
      getAvatar: async () => avatar,
      onAvatarChanged(callback: () => void) { changedAvatar = callback; return () => { changedAvatar = undefined; }; },
      getProfile: async () => ({ nickname: "Existing local nickname" }),
      onProfileChanged(callback: (profile: { nickname: string }) => void) { changedProfile = callback; return () => { changedProfile = undefined; }; },
    } });
    await act(async () => render());
    const trigger = button(t("ui.userMenu"));
    expect(trigger.getAttribute("aria-description")).toBe("Existing local nickname");
    expect(trigger.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,fixture-one");
    expect(trigger.querySelector(".is-placeholder")).toBeNull();
    avatar = "data:image/png;base64,fixture-two";
    await act(async () => { changedAvatar!(); changedProfile!({ nickname: "Updated local nickname" }); });
    expect(trigger.getAttribute("aria-description")).toBe("Updated local nickname");
    expect(trigger.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,fixture-two");
    act(() => root.unmount());
    expect(changedAvatar).toBeUndefined();
    expect(changedProfile).toBeUndefined();
  });
  it("puts the mode menu at the top of the sidebar and keeps it usable while plugins are open", async () => {
    render({ activePanel: "plugin" });
    expect(host.querySelector(".ff-page-titlebar .ff-mode-menu__trigger")).toBeNull();
    expect(host.querySelector(".ff-page-titlebar [role=\"tablist\"]")).toBeNull();
    const trigger = host.querySelector<HTMLButtonElement>(".ff-page-sidebar .ff-page-mode .ff-mode-menu__trigger")!;
    expect(trigger.textContent).toBe("Chat");
    await act(async () => trigger.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    expect(options.map(option => option.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    await act(async () => options[2].click());
    expect(props.onModeChange).toHaveBeenCalledExactlyOnceWith("code");
    expect(props.onTogglePanel).not.toHaveBeenCalled();
  });
  it("keeps a mode switch in the title bar while the sidebar is folded", () => {
    render({ collapsed: true, mode: "work" });
    const trigger = host.querySelector<HTMLButtonElement>(".ff-page-titlebar .ff-mode-menu__trigger")!;
    expect(trigger.textContent).toBe("Work");
    expect(trigger.classList.contains("is-compact")).toBe(true);
    expect(host.querySelector(".ff-page-sidebar .ff-mode-menu__trigger")).toBeNull();
  });
  it("opens the session switcher from the search row and selects by keyboard", async () => {
    const sessions = [
      { id: "a", title: "Alpha task", mode: "work", updatedAt: 3, workspaceDisplayName: "ProjectOne" },
      { id: "b", title: "Beta task", mode: "work", updatedAt: 2, workspaceDisplayName: "ProjectTwo" },
    ] as ChatPageNavigationProps["sessions"];
    render({ sessions });
    act(() => button(t("sidebar.searchAction")).click());
    await act(async () => {});
    const input = document.querySelector<HTMLInputElement>(".ff-sidebar-search input")!;
    expect(input).toBeTruthy();
    expect([...document.querySelectorAll(".ff-sidebar-search__title")].map(node => node.textContent)).toEqual(["Alpha task", "Beta task"]);
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => { setValue.call(input, "projecttwo"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect([...document.querySelectorAll(".ff-sidebar-search__title")].map(node => node.textContent)).toEqual(["Beta task"]);
    act(() => { document.querySelector(".ff-sidebar-search")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(props.onSelectSession).toHaveBeenCalledExactlyOnceWith("b");
  });
  it("opens the session switcher with Ctrl+K", async () => {
    render();
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => window.dispatchEvent(event));
    await act(async () => {});
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector(".ff-sidebar-search")).toBeTruthy();
  });
  it("marks the open panel on the rail and goes back to conversations from home", () => {
    render({ activePanel: "plugin" });
    const plugin = host.querySelector<HTMLButtonElement>('[data-rail-item="plugin"]')!;
    expect(plugin.getAttribute("aria-current")).toBe("page");
    act(() => host.querySelector<HTMLButtonElement>('[data-rail-item="home"]')!.click());
    expect(props.onTogglePanel).toHaveBeenCalledExactlyOnceWith("plugin");
  });
  it("opens a panel through ··· on the rail and returns keyboard focus on Escape", async () => {
    render();
    const more = button(t("ui.more"));
    await act(async () => more.click());
    const tool = document.querySelector<HTMLButtonElement>('[data-rail-menu-item="tool"]')!;
    act(() => tool.click());
    expect(props.onTogglePanel).toHaveBeenCalledWith("tool");
    await act(async () => more.click());
    act(() => document.querySelector(".ff-activity-rail__menu")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe(more);
  });
});

it("moves the sidebar to either bound with Home and End and restores that choice", () => {
  render();
  const handle = host.querySelector<HTMLElement>('[role="separator"]')!;
  act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
  expect(handle.getAttribute("aria-valuenow")).toBe("360");
  act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })));
  expect(handle.getAttribute("aria-valuenow")).toBe("180");
  render({ collapsed: true }); render();
  expect(host.querySelector('[role="separator"]')?.getAttribute("aria-valuenow")).toBe("180");
});

it("ends an in-flight resize on explicit collapse and ignores its remaining pointer moves", () => {
  render();
  const handle = host.querySelector<HTMLElement>('[role="separator"]')!;
  const pointer = (type: string, x: number) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { pointerId: 9, clientX: x, button: 0 });
  const release = vi.fn();
  Object.assign(handle, { setPointerCapture: vi.fn(), releasePointerCapture: release, hasPointerCapture: () => true });
  act(() => handle.dispatchEvent(pointer("pointerdown", 240)));
  act(() => window.dispatchEvent(pointer("pointermove", 280)));
  render({ collapsed: true });
  expect(host.querySelector(".is-resizing")).toBeNull();
  expect(release).toHaveBeenCalledExactlyOnceWith(9);
  act(() => window.dispatchEvent(pointer("pointermove", 340)));
  render();
  expect(host.querySelector('[role="separator"]')?.getAttribute("aria-valuenow")).toBe("280");
  expect(localStorage.getItem("firefly.chat.sidebar-width")).toBe("280");
});
