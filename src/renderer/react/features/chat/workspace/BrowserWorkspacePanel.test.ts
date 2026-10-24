// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserPageState, type BrowserPageState } from "./browser-page-state";
import { BrowserWorkspacePanel, type BrowserWorkspaceLabels } from "./BrowserWorkspacePanel";

const labels: BrowserWorkspaceLabels = {
  panel: "浏览器", address: "网页地址", go: "打开网页", back: "后退", forward: "前进",
  reload: "刷新", stop: "停止加载", close: "关闭网页", loading: "正在加载", blocked: "页面访问受阻",
  loadFailed: "页面加载失败", closed: "网页已关闭", viewport: "网页区域", empty: "输入网页地址以开始浏览",
};

let host: HTMLDivElement;
let root: Root;
let page: BrowserPageState;
let address: string;
const onAddressChange = vi.fn();
const onNavigate = vi.fn();
const onCommand = vi.fn();
const onClose = vi.fn();

function renderPanel(viewportRef?: (node: HTMLDivElement | null) => void) {
  act(() => root.render(createElement(BrowserWorkspacePanel, {
    page, address, labels, onAddressChange, onNavigate, onCommand, onClose, viewportRef,
    children: createElement("div", { "data-testid": "viewport-child" }, "页面占位内容"),
  })));
}

function findButton(label: string): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`button not found: ${label}`);
  return button;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  page = createBrowserPageState("session-a", "browser-a");
  address = "";
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("manual BrowserWorkspacePanel with injected callbacks", () => {
  it("offers stop after navigation begins and retains close during network initialization", () => {
    page = { ...page, loading: true, requestId: 1 }; renderPanel();
    expect(findButton(labels.stop).disabled).toBe(false);
    expect(host.querySelector(`button[aria-label="${labels.reload}"]`)).toBeNull();
    act(() => findButton(labels.stop).click()); expect(onCommand).toHaveBeenCalledExactlyOnceWith("stop");
    page = { ...page, requestId: 0 }; renderPanel();
    expect(findButton(labels.stop).disabled).toBe(true); expect(findButton(labels.close).disabled).toBe(false);
  });
  it("keeps all navigation blocked when the production consumer marks it unavailable", () => {
    address = "https://example.com";
    page = { ...page, url: address, canGoBack: true, canGoForward: true };
    act(() => root.render(createElement(BrowserWorkspacePanel, { page, address, labels, onAddressChange, onNavigate, onCommand, onClose, navigationAvailable: false })));
    for (const label of [labels.go, labels.back, labels.forward, labels.reload]) expect(findButton(label).disabled).toBe(true);
    const form = host.querySelector("form");
    act(() => form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onNavigate).not.toHaveBeenCalled(); expect(onCommand).not.toHaveBeenCalled();
    expect(findButton(labels.close).disabled).toBe(false);
  });
  it("allows an explicit address proposal while keeping ungranted history unavailable", () => {
    address = "https://docs.example/path";
    page = { ...page, url: "https://old.example/", canGoBack: true, canGoForward: true };
    act(() => root.render(createElement(BrowserWorkspacePanel, { page, address, labels, onAddressChange, onNavigate, onCommand, onClose, navigationAvailable: false, addressAvailable: true })));
    expect(findButton(labels.go).disabled).toBe(false);
    for (const label of [labels.back, labels.forward, labels.reload]) expect(findButton(label).disabled).toBe(true);
    act(() => findButton(labels.go).click());
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(address);
  });

  it("has labelled controls and disables unavailable history and reload", () => {
    renderPanel();
    expect(host.querySelector("input")?.getAttribute("aria-label")).toBe(labels.address);
    expect(findButton(labels.back).disabled).toBe(true);
    expect(findButton(labels.forward).disabled).toBe(true);
    expect(findButton(labels.reload).disabled).toBe(true);
    expect(findButton(labels.go).disabled).toBe(true);
    expect(findButton(labels.close).disabled).toBe(false);
  });

  it("exposes the named page viewport as an accessible region", () => {
    renderPanel();
    expect(host.querySelector('[role="region"]')?.getAttribute("aria-label")).toBe(labels.viewport);
  });

  it("attaches the viewport ref and releases it when the page closes", () => {
    const viewportRef = vi.fn<(node: HTMLDivElement | null) => void>();
    renderPanel(viewportRef);
    expect(viewportRef).toHaveBeenLastCalledWith(host.querySelector('[aria-label="网页区域"]'));
    expect(viewportRef.mock.calls[0]?.[0]).toBeInstanceOf(HTMLDivElement);
    page = { ...page, closed: true };
    renderPanel(viewportRef);
    expect(viewportRef.mock.calls.at(-1)?.[0]).toBeNull();
  });

  it("submits the trimmed address only through the injected navigation callback", () => {
    address = "  https://example.com/page  ";
    renderPanel();
    act(() => findButton(labels.go).click());
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("https://example.com/page");
    expect(window.location.href).not.toContain("example.com/page");
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("does not submit an empty address even through a form submit event", () => {
    address = " \t ";
    renderPanel();
    const form = host.querySelector("form");
    if (!form) throw new Error("form not found");
    act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("forwards user typing without starting navigation", () => {
    renderPanel();
    const input = host.querySelector<HTMLInputElement>("input");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!input || !setValue) throw new Error("address input missing");
    act(() => {
      setValue.call(input, "https://example.com/draft");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onAddressChange).toHaveBeenCalledExactlyOnceWith("https://example.com/draft");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it.each(["back", "forward", "reload"] as const)("dispatches the %s command once", (command) => {
    page = { ...page, url: "https://example.com/loaded", canGoBack: true, canGoForward: true };
    renderPanel();
    act(() => findButton(labels[command]).click());
    expect(onCommand).toHaveBeenCalledExactlyOnceWith(command);
  });

  it("forwards close only through the injected close callback", () => {
    renderPanel();
    act(() => findButton(labels.close).click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("shows loading while allowing the user to request a newer address", () => {
    page = { ...page, loading: true, pendingUrl: "https://example.com/loading" };
    address = "https://example.com/newer";
    renderPanel();
    expect(host.querySelector('[role="status"]')?.textContent).toBe(labels.loading);
    expect(host.querySelector('[aria-label="网页区域"]')?.getAttribute("aria-busy")).toBe("true");
    expect(findButton(labels.go).disabled).toBe(false);
  });

  it.each(["blocked", "load_failed"] as const)("shows the %s result as an alert", (error) => {
    page = { ...page, error };
    renderPanel();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(error === "blocked" ? labels.blocked : labels.loadFailed);
  });

  it("disables all commands and removes the page content when closed", () => {
    page = { ...page, closed: true, url: "https://example.com/old", canGoBack: true, canGoForward: true };
    address = "https://example.com/old";
    renderPanel();
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).every((button) => button.disabled)).toBe(true);
    expect(host.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
    expect(host.querySelector('[data-testid="viewport-child"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe(labels.closed);
  });

  it("updates the controlled address when the parent switches pages", () => {
    address = "https://example.com/first";
    renderPanel();
    page = createBrowserPageState("session-b", "browser-b");
    address = "https://example.com/second";
    renderPanel();
    expect(host.querySelector<HTMLInputElement>("input")?.value).toBe(address);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
