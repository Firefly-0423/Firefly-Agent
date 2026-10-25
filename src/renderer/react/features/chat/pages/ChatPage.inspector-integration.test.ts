// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatPage } from "./ChatPage";
import { FeedbackProvider } from "../../../components/feedback/FeedbackProvider";
import { BROWSER_PUBLIC_SCOPE, type BrowserPageDto, type ManualBrowserCommand } from "../../../../../shared/manual-browser";
import type { ChatStoreApi } from "./chat-page-bridge";

// Keep the actual panel library, ChatPage, inspector and browser components.
// Only supply DOM measurements and explicit offline preload boundaries.
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let dockWidth: number;
let browserPage: BrowserPageDto | null;
let commands: ManualBrowserCommand[];
let revoked: number;
const browserListeners = new Set<(page: BrowserPageDto) => void>();
const observers = new Set<MeasuredResizeObserver>();
class MeasuredResizeObserver {
  targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); observers.delete(this); }
}
function size(element: HTMLElement, axis: "width" | "height"): number {
  const extent = axis === "width" ? dockWidth : 720;
  if (!element.hasAttribute("data-panel")) return extent;
  const group = element.parentElement!;
  if ((group.style.flexDirection === "column") !== (axis === "height")) return extent;
  const panels = [...group.children].filter(node => node.hasAttribute("data-panel")) as HTMLElement[];
  const total = panels.reduce((sum, panel) => sum + Number(panel.style.flexGrow || 1), 0);
  return extent * Number(element.style.flexGrow || 1) / (total || 1);
}
function rect(element: HTMLElement): DOMRect {
  const width = size(element, "width"), height = size(element, "height");
  const before = element.id === "inspector" ? document.getElementById("chat") : null;
  const vertical = element.parentElement?.style.flexDirection === "column";
  const x = 100 + (before && !vertical ? size(before, "width") : 0);
  const y = 80 + (before && vertical ? size(before, "height") : 0);
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON() {} } as DOMRect;
}
async function measuredUpdate() {
  await act(async () => {
    for (const observer of [...observers]) {
      observer.callback([...observer.targets].map(target => {
        const contentRect = rect(target as HTMLElement);
        return { target, contentRect, borderBoxSize: [{ inlineSize: contentRect.width, blockSize: contentRect.height }] } as ResizeObserverEntry;
      }), observer as unknown as ResizeObserver);
    }
  });
}
function button(label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.getAttribute("aria-label") === label);
  expect(result, label).toBeDefined();
  return result!;
}
async function click(node: HTMLElement) { await act(async () => node.click()); await measuredUpdate(); }
function input(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}
const inspector = () => host.querySelector<HTMLElement>(".ff-right-inspector");
const panelWidth = () => Number(host.querySelector<HTMLElement>('[data-panel][id="inspector"]')?.style.flexGrow);

beforeEach(async () => {
  localStorage.clear(); dockWidth = 1000; browserPage = null; commands = []; revoked = 0; browserListeners.clear();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", MeasuredResizeObserver);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request in offline fixture"); }));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function () { return size(this, "width"); });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function () { return size(this, "height"); });
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function () { return rect(this).left; });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function () { return rect(this).top; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () { return rect(this); });
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => computed(element));
  const session = { id: "inspector-fixture", mode: "chat", title: "Inspector integration", identityId: null, createdAt: 1, updatedAt: 1, messageCount: 0, messages: [] };
  window.chatStore = {
    list: async options => !options?.mode || options.mode === "chat" ? [session] : [], get: async () => session,
    onChanged: () => () => {}, onReactSwitchSession: () => () => {}, notifyReactReady() {},
    setActiveSession: async () => {}, pendingList: async () => [], pendingClaim: async () => ({ ok: true, claimed: false }), getRendererTargetId: () => "inspector-renderer",
  } as unknown as ChatStoreApi;
  window.manualBrowser = {
    getAvailability: async () => ({ available: true }), onChanged: listener => { browserListeners.add(listener); return () => { browserListeners.delete(listener); }; },
    execute: async command => {
      commands.push(command);
      if (!["get", "layout", "close"].includes(command.kind)) throw new Error(`Unexpected browser command: ${command.kind}`);
      return { ok: true, value: command.kind === "get" ? browserPage : null };
    },
    getPermission: async () => ({ ok: true, value: { conversationId: session.id, status: "granted", scope: BROWSER_PUBLIC_SCOPE, requestId: null } }),
    requestPermission: async () => { throw new Error("Unexpected permission request"); },
    revokePermission: async () => { revoked++; return { ok: true, value: { conversationId: session.id, status: "required", scope: BROWSER_PUBLIC_SCOPE, requestId: null } }; },
  };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(React.createElement(FeedbackProvider, null, React.createElement(ChatPage))));
  await measuredUpdate();
  expect(host.querySelector("header h1")?.textContent).toBe(session.title);
});
afterEach(async () => {
  await act(async () => root?.unmount()); host?.remove();
  delete window.chatStore; delete window.manualBrowser;
  observers.clear(); browserListeners.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("registers the first inspector before imperative expansion with the real panel library", async () => {
  await click(button("文件"));
  expect(inspector()).not.toBeNull();
  expect(inspector()?.hidden).toBe(false);
  expect(panelWidth()).toBeGreaterThan(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("preserves browser, composer and resized width over hide/show and close/reopen", async () => {
  const composer = host.querySelector<HTMLTextAreaElement>("textarea.ant-sender-input")!;
  await act(async () => input(composer, "unsent fixture draft"));
  browserPage = { browserId: "browser-fixture", conversationId: "inspector-fixture", requestId: 1, closed: false, loading: false, url: "https://example.invalid/fixture", pendingUrl: null, canGoBack: false, canGoForward: false, error: null };
  await click(button("打开浏览器"));
  const address = inspector()!.querySelector<HTMLInputElement>("input")!;
  expect(address.value).toBe(browserPage.url);
  await act(async () => input(address, "https://example.invalid/unsent-address"));
  const separator = host.querySelector<HTMLElement>(".ff-dock-separator")!;
  await act(async () => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  const width = panelWidth();
  expect(width).toBeGreaterThan(40);
  const savedLayout = localStorage.getItem("react-resizable-panels:firefly.chat-page-dock:chat:inspector");
  expect(savedLayout).not.toBeNull();
  for (let repeat = 0; repeat < 3; repeat++) {
    await click(button("展开/收起右侧面板"));
    expect(inspector()?.hidden).toBe(true); expect(panelWidth()).toBe(0);
    await click(button("展开/收起右侧面板"));
    expect(inspector()?.hidden).toBe(false); expect(panelWidth()).toBeCloseTo(width);
    expect(inspector()?.querySelector("input")).toBe(address);
    expect(address.value).toBe("https://example.invalid/unsent-address");
    expect(host.querySelector("textarea.ant-sender-input")).toBe(composer);
    expect(composer.value).toBe("unsent fixture draft");
  }
  expect(localStorage.getItem("react-resizable-panels:firefly.chat-page-dock:chat:inspector")).toBe(savedLayout);
  expect(commands.some(command => command.kind === "close")).toBe(false); expect(revoked).toBe(0);
  for (let repeat = 0; repeat < 2; repeat++) {
    // A last-tab close/reopen must not rely on another ResizeObserver delivery.
    await act(async () => inspector()!.querySelector<HTMLElement>(".ff-right-inspector__close")!.click());
    expect(inspector()).toBeNull();
    await act(async () => button("打开浏览器").click());
    await measuredUpdate();
    expect(inspector()?.hidden).toBe(false); expect(panelWidth()).toBeGreaterThan(0);
  }
  // Closing awaits Main-owned grant/page cleanup; hiding above never revokes it.
  expect(revoked).toBe(2);
  expect(commands.some(command => command.kind === "close")).toBe(false);
  expect(composer.value).toBe("unsent fixture draft"); expect(fetch).not.toHaveBeenCalled();
});

it("keeps registration current across compact orientation changes and Work mode activation", async () => {
  await click(button("文件"));
  const before = inspector();
  dockWidth = 500; await measuredUpdate();
  expect(host.querySelector(".ff-page-dock")?.classList.contains("is-compact")).toBe(true);
  await click(button("展开/收起右侧面板")); expect(panelWidth()).toBe(0);
  dockWidth = 1000; await measuredUpdate();
  await click(button("展开/收起右侧面板")); expect(panelWidth()).toBeGreaterThan(0);
  expect(inspector()).toBe(before);
  await click(inspector()!.querySelector<HTMLElement>(".ff-right-inspector__close")!);
  await click(host.querySelector<HTMLElement>(".ff-mode-menu__trigger")!);
  await click([...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.textContent?.includes("Work"))!);
  expect(host.querySelector(".ff-mode-menu__trigger")?.textContent).toContain("Work");
  expect(inspector()?.hidden).toBe(false); expect(panelWidth()).toBeGreaterThan(0);
  expect(fetch).not.toHaveBeenCalled();
});


it("treats a restored zero-size inspector as registered and expands it on explicit opening", async () => {
  await act(async () => root.unmount());
  localStorage.setItem("react-resizable-panels:firefly.chat-page-dock:chat:inspector", JSON.stringify({ chat: 100, inspector: 0 }));
  root = createRoot(host);
  await act(async () => root.render(React.createElement(FeedbackProvider, null, React.createElement(ChatPage))));
  await measuredUpdate();
  await click(button("文件"));
  expect(inspector()?.hidden).toBe(false); expect(panelWidth()).toBeGreaterThan(0);
  expect(JSON.parse(localStorage.getItem("react-resizable-panels:firefly.chat-page-dock:chat:inspector")!)).toEqual({ chat: 100, inspector: 0 });
});

it("does not expand a user-collapsed panel merely because the numeric layout changed", async () => {
  await click(button("文件"));
  const separator = host.querySelector<HTMLElement>(".ff-dock-separator")!;
  await act(async () => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  await measuredUpdate();
  expect(panelWidth()).toBe(0);
  // A collapsed pane no longer pins the chat column to its fixed width; it is back to the responsive one.
  expect(host.querySelector(".ff-page-dock")?.classList.contains("has-inspector")).toBe(false);
  await measuredUpdate(); expect(panelWidth()).toBe(0);
  // Visibility toggles still restore it, including consecutive commits before measurement.
  await act(async () => button("展开/收起右侧面板").click());
  await act(async () => button("展开/收起右侧面板").click());
  await measuredUpdate();
  expect(panelWidth()).toBeGreaterThan(0);
  expect(host.querySelector(".ff-page-dock")?.classList.contains("has-inspector")).toBe(true);
});


it("mounts an initially hidden browser inspector collapsed and reveals the same page afterward", async () => {
  await click(button("插件"));
  browserPage = { browserId: "hidden-browser-fixture", conversationId: "inspector-fixture", requestId: 1, closed: false, loading: false, url: "https://example.invalid/hidden", pendingUrl: null, canGoBack: false, canGoForward: false, error: null };
  await act(async () => { for (const listener of [...browserListeners]) listener(browserPage!); });
  await measuredUpdate();
  const hidden = inspector();
  expect(hidden).not.toBeNull(); expect(hidden?.hidden).toBe(true); expect(panelWidth()).toBe(0);
  const address = hidden!.querySelector<HTMLInputElement>("input")!;
  expect(address.value).toBe(browserPage.url);
  // "会话" on the activity rail leaves the panel and returns to the workbench.
  await click(button("会话"));
  expect(inspector()).toBe(hidden); expect(inspector()?.hidden).toBe(false); expect(panelWidth()).toBeGreaterThan(0);
  expect(inspector()?.querySelector("input")).toBe(address);
  expect(commands.some(command => command.kind === "close")).toBe(false);
});

it("persists a keyboard inspector resize immediately after a sidebar pointercancel", async () => {
  const left = host.querySelector<HTMLElement>('.ff-sidebar-resizer')!;
  const pointer = (type: string, x: number) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    pointerId: 21, pointerType: "mouse", clientX: x, clientY: 90, button: 0,
  });
  await act(async () => left.dispatchEvent(pointer("pointerdown", 50)));
  await act(async () => window.dispatchEvent(pointer("pointermove", 70)));
  await act(async () => left.dispatchEvent(pointer("pointercancel", 70)));
  await click(button("打开浏览器"));
  const key = "react-resizable-panels:firefly.chat-page-dock:chat:inspector";
  expect(localStorage.getItem(key)).toBeNull();
  const separator = host.querySelector<HTMLElement>(".ff-dock-separator")!;
  await act(async () => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })));
  const width = panelWidth();
  expect(width).toBeGreaterThan(40);
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(JSON.parse(localStorage.getItem(key)!).inspector).toBeCloseTo(width);
  await click(button("展开/收起右侧面板"));
  await click(button("展开/收起右侧面板"));
  expect(panelWidth()).toBeCloseTo(width);
  expect(JSON.parse(localStorage.getItem(key)!).inspector).toBeCloseTo(width);
});

it("keeps the overview cards when a right panel opens and keeps the conversation readable when the separator is dragged", async () => {
  await click(button("打开会话概览"));
  expect(host.querySelector(".ff-chat-cards")).not.toBeNull();
  // The column stays open across modes, conversations and restarts.
  expect(localStorage.getItem("ff.chat.overviewOpen")).toBe("1");
  // Opening a right panel leaves the cards where they are; only the header switch folds them.
  await click(button("文件"));
  expect(host.querySelector(".ff-chat-cards")).not.toBeNull();
  expect(inspector()?.hidden).toBe(false);
  const separator = host.querySelector<HTMLElement>(".ff-dock-separator")!;
  for (let step = 0; step < 40; step++) await act(async () => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  const chat = host.querySelector<HTMLElement>('[data-panel][id="chat"]')!;
  // The 1000px dock cannot hold the 480px dialog + 280px cards and the panel's own 280px, so the conversation keeps all but those.
  expect(size(chat, "width")).toBeGreaterThanOrEqual(1000 - 280 - 12 - 1);
  await click(button("打开会话概览"));
  // The cards slide out first (inert while they do), then leave the DOM.
  expect(host.querySelector(".ff-chat-cards.is-leaving")?.hasAttribute("inert")).toBe(true);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
  expect(host.querySelector(".ff-chat-cards")).toBeNull();
  for (let step = 0; step < 40; step++) await act(async () => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  expect(size(chat, "width")).toBeGreaterThanOrEqual(479);
});

it("closes the browser from the header switch through its own cleanup", async () => {
  browserPage = { browserId: "switch-browser-fixture", conversationId: "inspector-fixture", requestId: 1, closed: false, loading: false, url: "https://example.invalid/switch", pendingUrl: null, canGoBack: false, canGoForward: false, error: null };
  await click(button("打开浏览器"));
  expect(host.querySelector('[data-inspector-pane="browser"]')).not.toBeNull();
  const revokedBefore = revoked;
  await click(button("打开浏览器"));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  await measuredUpdate();
  // The switch went through the browser's own close: its grant is revoked (Main then closes its pages), not a bare unmount.
  expect(revoked).toBe(revokedBefore + 1);
  expect(host.querySelector('[data-inspector-pane="browser"]')).toBeNull();
});
